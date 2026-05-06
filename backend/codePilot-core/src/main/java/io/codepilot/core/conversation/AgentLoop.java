package io.codepilot.core.conversation;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.conversation.ToolResultBus.ToolResultEvent;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.dto.DoneReason;
import io.codepilot.core.dto.ModelEnvelope;
import io.codepilot.core.dto.ToolCall;
import io.codepilot.core.rag.ServerToolExecutor;
import io.codepilot.core.sse.SseEvents;
import java.time.Duration;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.http.codec.ServerSentEvent;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Plan-First multi-turn loop. One {@code /v1/conversation/run} call may drive several model
 * invocations:
 *
 * <pre>
 *   model() ──▶ envelope ──┬─▶ (final) → done(final)
 *                          ├─▶ (toolCall) → tool_call SSE → wait tool-result on the bus
 *                          │     └─▶ append observation to history → loop
 *                          ├─▶ (needsInput) → done(awaiting_user_input)
 *                          └─▶ (parse failure / max steps) → done(failed|max_steps)
 * </pre>
 */
public final class AgentLoop {

  private static final Logger log = LoggerFactory.getLogger(AgentLoop.class);
  private static final Duration TOOL_RESULT_TIMEOUT = Duration.ofMinutes(5);

  private final ChatClient chatClient;
  private final EnvelopeStreamParser parser;
  private final ToolResultBus bus;
  private final StopSignalBus stopBus;
  private final ObjectMapper mapper;
  private final SseFactory sse;
  private final ServerToolExecutor serverToolExecutor;

  public AgentLoop(
      ChatClient chatClient,
      EnvelopeStreamParser parser,
      ToolResultBus bus,
      StopSignalBus stopBus,
      ObjectMapper mapper,
      SseFactory sse,
      ServerToolExecutor serverToolExecutor) {
    this.chatClient = chatClient;
    this.parser = parser;
    this.bus = bus;
    this.stopBus = stopBus;
    this.mapper = mapper;
    this.sse = sse;
    this.serverToolExecutor = serverToolExecutor;
  }

  /** Runs the loop and emits SSE events; respects {@code maxSteps} from the request policy. */
  public Flux<ServerSentEvent<String>> run(
      ConversationRunRequest req, String systemText, String userText) {
    int maxSteps =
        req.policy() != null && req.policy().maxSteps() != null ? req.policy().maxSteps() : 8;

    State state = new State(systemText, userText, maxSteps, req.sessionId());

    // Populate completed tool call IDs from resume context for idempotency
    if (req.completedToolCallsTail() != null) {
      req.completedToolCallsTail().forEach(tc -> {
        if (tc.toolCallId() != null) {
          state.completedToolCallIds.add(tc.toolCallId());
          state.history.append("[resumed:" + tc.name() + "] " + (Boolean.TRUE.equals(tc.ok()) ? "OK" : "ERR") + " (skipped)");
        }
      });
    }

    Flux<ServerSentEvent<String>> stop =
        stopBus
            .subscribe(req.sessionId())
            .next()
            .flatMapMany(
                ignored ->
                    Flux.just(sse.event(SseEvents.DONE, Map.of("reason", "stopped"))));

    return Flux.<ServerSentEvent<String>>create(sink -> drive(state, sink))
        .takeUntilOther(stop);
  }

  private void drive(State state, reactor.core.publisher.FluxSink<ServerSentEvent<String>> sink) {
    nextTurn(state)
        .subscribe(
            evt -> sink.next(evt),
            err -> {
              log.warn("AgentLoop error", err);
              sink.next(sse.error(50001, "Loop error"));
              sink.next(sse.event(SseEvents.DONE, Map.of("reason", "failed")));
              sink.complete();
            },
            sink::complete);
  }

  private Flux<ServerSentEvent<String>> nextTurn(State state) {
    if (state.steps >= state.maxSteps) {
      return Flux.just(sse.event(SseEvents.DONE, Map.of("reason", "max_steps")));
    }
    state.steps++;

    // Resume idempotency: skip tool calls that were already completed in a previous session
    // The completedToolCallIds set is populated from the request's completedToolCallsTail.

    return invokeModel(state)
        .flatMapMany(
            buffered -> {
              ModelEnvelope env = parser.parseFinal(buffered);
              if (env == null) {
                // Treat as plain text reply: emit a single delta + final.
                return Flux.just(
                    sse.event(SseEvents.DELTA, Map.of("text", buffered)),
                    sse.event(SseEvents.DONE, Map.of("reason", "final")));
              }
              return dispatchEnvelope(state, env);
            });
  }

  private Flux<ServerSentEvent<String>> dispatchEnvelope(State state, ModelEnvelope env) {
    Flux<ServerSentEvent<String>> emitted = Flux.empty();
    if (env.digest() != null) emitted = emitted.concatWith(Flux.just(sse.event(SseEvents.DIGEST, env.digest())));
    if (env.taskLedger() != null)
      emitted = emitted.concatWith(Flux.just(sse.event(SseEvents.TASK_LEDGER, env.taskLedger())));
    if (env.taskLedgerDelta() != null)
      emitted = emitted.concatWith(Flux.just(sse.event(SseEvents.TASK_LEDGER, env.taskLedgerDelta())));
    if (env.plan() != null) emitted = emitted.concatWith(Flux.just(sse.event(SseEvents.PLAN, env.plan())));
    if (env.planDelta() != null)
      emitted = emitted.concatWith(Flux.just(sse.event(SseEvents.PLAN_DELTA, env.planDelta())));
    if (env.selfCheck() != null)
      emitted = emitted.concatWith(Flux.just(sse.event(SseEvents.SELF_CHECK, env.selfCheck())));
    if (env.riskNotice() != null)
      emitted = emitted.concatWith(Flux.just(sse.event(SseEvents.RISK_NOTICE, env.riskNotice())));

    if (env.needsInput() != null) {
      return emitted
          .concatWith(Flux.just(sse.event(SseEvents.NEEDS_INPUT, env.needsInput())))
          .concatWith(Flux.just(sse.event(SseEvents.DONE, Map.of("reason", "awaiting_user_input"))));
    }
    if (env.finalAnswer() != null) {
      return emitted
          .concatWith(Flux.just(sse.event(SseEvents.DELTA, Map.of("text", env.finalAnswer().answer() == null ? "" : env.finalAnswer().answer()))))
          .concatWith(
              Flux.just(
                  sse.event(
                      SseEvents.DONE,
                      Map.of(
                          "reason",
                          Boolean.TRUE.equals(env.finalAnswer().subtaskDone())
                              ? "subtask_done"
                              : "final"))));
    }
    if (env.toolCall() != null) {
      ToolCall tc = env.toolCall();

      // Idempotency: skip already-completed tool calls from a resumed session
      if (state.completedToolCallIds.contains(tc.id())) {
        state.history.append("[tool:" + tc.name() + "] SKIPPED (already completed)");
        return emitted.concatWith(nextTurn(state));
      }

      Flux<ServerSentEvent<String>> toolEvent =
          Flux.just(sse.event(SseEvents.TOOL_CALL, tc));

      // Server-side tool execution: run locally without waiting for client.
      if (serverToolExecutor.isServerTool(tc.name())) {
        return emitted
            .concatWith(toolEvent)
            .concatWith(
                Mono.fromCallable(
                        () -> {
                          JsonNode argsNode = mapper.valueToTree(tc.args());
                          return serverToolExecutor.execute(tc.name(), argsNode, state.sessionId);
                        })
                    .doOnNext(
                        result ->
                            state.history.append("[tool:" + tc.name() + "] OK: " + result))
                    .flatMapMany(
                        result ->
                            Flux.<ServerSentEvent<String>>just(
                                    sse.event(
                                        SseEvents.TOOL_RESULT_ACK,
                                        Map.of(
                                            "toolCallId", tc.id(),
                                            "ok", true,
                                            "serverResult", result)))
                                .concatWith(nextTurn(state))));
      }

      // Client-side tool execution: emit tool_call and wait for result on the bus.
      Mono<ToolResultEvent> waitResult =
          bus.subscribe(state.sessionId)
              .filter(e -> e.toolCallId() != null && e.toolCallId().equals(tc.id()))
              .next()
              .timeout(TOOL_RESULT_TIMEOUT);

      return emitted
          .concatWith(toolEvent)
          .concatWith(
              waitResult
                  .doOnNext(
                      r ->
                          state.history.append(
                              "[tool:" + tc.name() + "] " + (r.ok() ? "OK" : "ERR")))
                  .flatMapMany(
                      r ->
                          Flux.<ServerSentEvent<String>>just(
                                  sse.event(
                                      SseEvents.TOOL_RESULT_ACK,
                                      Map.of(
                                          "toolCallId", tc.id(),
                                          "ok", r.ok())))
                              .concatWith(nextTurn(state))));
    }
    return emitted.concatWith(Flux.just(sse.event(SseEvents.DONE, Map.of("reason", "final"))));
  }

  /** Calls the model and returns the buffered text. */
  private Mono<String> invokeModel(State state) {
    return chatClient
        .prompt()
        .messages(
            new SystemMessage(state.systemText),
            new UserMessage(state.userText + state.history.tail()))
        .stream()
        .chatResponse()
        .map(ChatResponse::getResult)
        .filter(r -> r != null && r.getOutput() != null)
        .map(r -> {
          var msg = r.getOutput();
          return msg.getContent() == null ? "" : msg.getContent();
        })
        .reduce(new StringBuilder(), StringBuilder::append)
        .map(StringBuilder::toString);
  }

  /** In-memory loop state (per /run call). */
  private static final class State {
    final String systemText;
    final String userText;
    final int maxSteps;
    final String sessionId;
    int steps;
    final History history = new History();
    final java.util.Set<String> completedToolCallIds = new java.util.HashSet<>();

    State(String systemText, String userText, int maxSteps, String sessionId) {
      this.systemText = systemText;
      this.userText = userText;
      this.maxSteps = maxSteps;
      this.sessionId = sessionId;
    }
  }

  private static final class History {
    private final StringBuilder buf = new StringBuilder();

    void append(String line) {
      buf.append("\n").append(line);
    }

    String tail() {
      return buf.length() == 0 ? "" : "\n[observations]" + buf;
    }
  }
}
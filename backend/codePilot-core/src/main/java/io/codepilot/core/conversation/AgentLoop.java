package io.codepilot.core.conversation;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.conversation.ToolResultBus.ToolResultEvent;
import io.codepilot.core.dto.*;
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
        req.policy() != null && req.policy().maxSteps() != null ? req.policy().maxSteps() : 25;

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
                sink::next,
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
                // ★ EnvelopeValidator: JSON解析失败时尝试一次自动修正
                if (state.parseRetries < 1) {
                  state.parseRetries++;
                  // ★ Before retrying, check if this is a Graph-format JSON (patches/thought/agentThinking)
                  // that doesn't match ModelEnvelope but is still valid JSON.
                  // If so, extract user-facing fields instead of dumping raw text.
                  Flux<ServerSentEvent<String>> graphFallback = tryGraphFormatFallback(buffered, state);
                  if (graphFallback != null) return graphFallback;

                  log.warn("Model output was not valid JSON, requesting self-correction for session {}",
                      state.sessionId);
                  state.history.append(
                      "[SYSTEM: Your previous reply was not valid JSON. Please output ONLY the strict JSON envelope as specified.]");
                  return nextTurn(state); // 重试一次
                }
                // ★ Before falling back to raw text, check for Graph-format JSON
                Flux<ServerSentEvent<String>> graphFallback = tryGraphFormatFallback(buffered, state);
                if (graphFallback != null) return graphFallback;

                // 两次解析都失败，降级为纯文本
                log.warn("Model output still not valid JSON after retry, falling back to plain text for session {}",
                    state.sessionId);
                return Flux.just(
                    sse.event(SseEvents.DELTA, Map.of("text", buffered)),
                    sse.event(SseEvents.DONE, Map.of("reason", "final")));
              }
              state.parseRetries = 0; // 解析成功则重置
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
    if (env.selfCheck() != null) {
      emitted = emitted.concatWith(Flux.just(sse.event(SseEvents.SELF_CHECK, env.selfCheck())));
      // ★ SelfCheck 强制校验逻辑
      SelfCheck sc = env.selfCheck();
      if (Boolean.TRUE.equals(sc.ok()) && Boolean.TRUE.equals(sc.matchedExpectation())) {
        // 成功: 重置连续失败计数器
        state.recordSuccess();
      } else {
        // 失败: 记录并检查是否需要强制replan
        boolean shouldReplan = state.recordFailure();
        log.warn("SelfCheck failed (consecutiveFailures={}, forceReplan={}) for session {}",
            state.consecutiveFailures, state.forceReplan, state.sessionId);
        // 如果nextAction=retry但已连续失败3次，强制改为replan
        if (sc.nextAction() == SelfCheck.Action.RETRY && shouldReplan) {
          log.warn("Overriding selfCheck nextAction from retry to replan due to {} consecutive failures",
              state.consecutiveFailures);
          // 注入replan提示到history，下一轮模型必须输出全量plan
          state.history.append("[SYSTEM: 3 consecutive failures detected. You MUST output a full `plan` (replan) in this reply. Do NOT retry the same step.]");
          state.forceReplan = true;
        }
      }
    }
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
                      r -> {
                        state.history.append(
                            "[tool:" + tc.name() + "] " + (r.ok() ? "OK" : "ERR"));
                        // ★ 记录工具执行失败
                        if (!r.ok()) {
                          state.recordFailure();
                          log.warn("Client tool {} failed (consecutiveFailures={}) for session {}",
                              tc.name(), state.consecutiveFailures, state.sessionId);
                        } else {
                          state.recordSuccess();
                        }
                      })
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
    // ★ 如果forceReplan=true，在system尾部追加replan段
    String systemText = state.systemText;
    if (state.forceReplan) {
      systemText = systemText + "\n\n[REPLAN REQUIRED]\nThe previous attempts failed or drifted. In this reply you MUST:\n"
          + "- Output a FULL `plan` (not planDelta).\n"
          + "- Keep `goal` unchanged; reset all pending steps; try a different decomposition or tool choice.\n"
          + "- Add a verification step early if the failure looks environmental.\n"
          + "Then continue with one `toolCall` for the first new step.\n";
      state.forceReplan = false; // 重置标志
    }

    return chatClient
        .prompt()
        .messages(
            new SystemMessage(systemText),
            new UserMessage(state.userText + state.history.tail()))
        .stream()
        .chatResponse()
        .map(ChatResponse::getResult)
        .filter(r -> r != null && r.getOutput() != null)
        .map(r -> {
          var msg = r.getOutput();
          return msg.getText() == null ? "" : msg.getText();
        })
        .reduce(new StringBuilder(), StringBuilder::append)
        .map(StringBuilder::toString);
  }

  /**
   * Attempts to extract user-facing content from a Graph-format JSON response
   * (contains patches/thought/agentThinking/agentContent but NOT toolCall/finalAnswer/needsInput).
   * Returns structured SSE events or null if the buffered text is not valid Graph-format JSON.
   */
  private Flux<ServerSentEvent<String>> tryGraphFormatFallback(String buffered, State state) {
    JsonNode tree = parser.parseTree(buffered);
    if (tree == null) return null;

    // Detect Graph-format: has patches/thought/agentThinking but NOT toolCall/finalAnswer
    boolean hasGraphFields = tree.has("patches") || tree.has("thought")
        || tree.has("agentThinking") || tree.has("agentContent") || tree.has("textOutput");
    boolean hasEnvelopeFields = tree.has("toolCall") || tree.has("finalAnswer") || tree.has("needsInput");
    if (!hasGraphFields || hasEnvelopeFields) return null;

    log.info("AgentLoop: detected Graph-format JSON output, extracting structured fields for session {}",
        state.sessionId);

    java.util.List<ServerSentEvent<String>> events = new java.util.ArrayList<>();

    // Emit agent_thinking if present
    String agentThinking = tree.path("agentThinking").asText(null);
    if (agentThinking != null && !agentThinking.isBlank()) {
      events.add(sse.event(SseEvents.AGENT_THINKING,
          Map.of("text", agentThinking)));
    }

    // Emit agentContent as delta if present
    String agentContent = tree.path("agentContent").asText(null);
    if (agentContent != null && !agentContent.isBlank()) {
      events.add(sse.event(SseEvents.DELTA, Map.of("text", agentContent + "\n\n")));
    }

    // Emit textOutput as delta if present
    String textOutput = tree.path("textOutput").asText(null);
    if (textOutput != null && !textOutput.isBlank()) {
      events.add(sse.event(SseEvents.DELTA, Map.of("text", textOutput)));
    }

    // If no content was extracted, emit thought as delta
    if (events.isEmpty()) {
      String thought = tree.path("thought").asText(null);
      if (thought != null && !thought.isBlank()) {
        events.add(sse.event(SseEvents.DELTA, Map.of("text", thought)));
      }
    }

    // Always end with done(final)
    events.add(sse.event(SseEvents.DONE, Map.of("reason", "final")));

    return Flux.fromIterable(events);
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

    // ── SelfCheck failure tracking ──────────────────────────────
    /** Number of consecutive selfCheck.ok=false or tool execution failures. */
    int consecutiveFailures = 0;
    /** Max consecutive failures before forcing replan. */
    static final int MAX_CONSECUTIVE_FAILURES = 3;
    /** Whether replan should be forced on the next turn. */
    boolean forceReplan = false;
    /** Number of times we've retried JSON parse (EnvelopeValidator). */
    int parseRetries = 0;

    State(String systemText, String userText, int maxSteps, String sessionId) {
      this.systemText = systemText;
      this.userText = userText;
      this.maxSteps = maxSteps;
      this.sessionId = sessionId;
    }

    /** Record a successful selfCheck/tool execution, resetting failure counter. */
    void recordSuccess() {
      consecutiveFailures = 0;
    }

    /** Record a failure. Returns true if we've hit the replan threshold. */
    boolean recordFailure() {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        forceReplan = true;
      }
      return forceReplan;
    }
  }

  private static final class History {
    private final StringBuilder buf = new StringBuilder();

    void append(String line) {
      buf.append("\n").append(line);
    }

    String tail() {
      return buf.isEmpty() ? "" : "\n[observations]" + buf;
    }
  }
}
package io.codepilot.core.agent;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.common.conversation.AgentEvent.ToolCallEvent;
import io.codepilot.common.conversation.AgentEvent.UsageEvent;
import io.codepilot.common.conversation.ConversationRequest;
import io.codepilot.common.conversation.ConversationRequest.Mode;
import io.codepilot.common.conversation.ToolResultRequest;
import io.codepilot.core.ai.SafeguardAdvisor;
import io.codepilot.core.metrics.MetricsHelper;
import io.codepilot.core.model.ModelService;
import io.codepilot.core.prompt.PromptOrchestrator;
import io.codepilot.core.prompt.PromptOrchestrator.AgentState;
import io.codepilot.core.tool.ToolRouter;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Sinks;

/**
 * Core agent loop that drives the multi-turn conversation within a single SSE stream.
 *
 * <p>For {@code mode=chat}: single model call → stream deltas → done.
 *
 * <p>For {@code mode=agent}: multi-turn loop:
 *
 * <pre>
 * while (steps < maxSteps) {
 *   1. Assemble prompt via PromptOrchestrator
 *   2. Call model (streaming)
 *   3. Parse model response JSON → emit SSE events (plan/planDelta/toolCall/final/digest/...)
 *   4. If toolCall: emit ToolCallEvent, await client result, continue
 *   5. If final: emit DoneEvent, break
 * }
 * </pre>
 */
@Service
public class AgentLoop {

  private static final Logger LOG = LoggerFactory.getLogger(AgentLoop.class);
  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final Duration TOOL_RESULT_TIMEOUT = Duration.ofMinutes(5);

  private final ModelService modelService;
  private final PromptOrchestrator orchestrator;
  private final ToolRouter toolRouter;
  private final SafeguardAdvisor safeguardAdvisor;
  private final MetricsHelper metrics;

  public AgentLoop(ModelService modelService, PromptOrchestrator orchestrator, ToolRouter toolRouter,
      SafeguardAdvisor safeguardAdvisor, MetricsHelper metrics) {
    this.modelService = modelService;
    this.orchestrator = orchestrator;
    this.toolRouter = toolRouter;
    this.safeguardAdvisor = safeguardAdvisor;
    this.metrics = metrics;
  }

  /**
   * Runs the conversation loop, returning a Flux of SSE events.
   *
   * <p>The Flux completes when the loop reaches a natural stopping point (final / subtask_done /
   * max_steps / error).
   */
  /**
   * Runs the conversation loop, returning a Flux of SSE events.
   *
   * <p>Resolves the ChatClient dynamically based on the request's modelId.
   * The Flux completes when the loop reaches a natural stopping point.
   */
  public Flux<AgentEvent> run(ConversationRequest req) {
    long startTime = System.currentTimeMillis();
    // Resolve the ChatClient for the requested model
    return modelService.resolveChatClient(req.modelId(), userIdFromContext())
        .flatMapMany(chatClient -> Flux.create(sink -> {
          AgentState state = new AgentState();
          int maxSteps = req.policy() != null ? req.policy().maxSteps() : 25;

          if (req.mode() == Mode.chat) {
            runChat(chatClient, req, state, sink, startTime);
          } else {
            runAgent(chatClient, req, state, maxSteps, sink, startTime);
          }

          sink.onDispose(
              () -> LOG.debug("SSE stream disposed for session={}", req.sessionId()));
        }));
  }

  /** Extracts user ID from the current security context (set by gateway JWT filter). */
  private String userIdFromContext() {
    // In the gateway flow, the user ID is propagated via the SecurityContext.
    // For now, return a placeholder — the ConversationController will pass it via request attrs.
    return "system";
  }

  /** Chat mode: single model call, stream text deltas, then done. */
  private void runChat(
      ChatClient chatClient, ConversationRequest req, AgentState state,
      Sinks.Many<AgentEvent> sink, long startTime) {
    try {
      Prompt prompt = orchestrator.assemble(req, state, null);
      prompt = safeguardAdvisor.sanitize(prompt);

      // Use Spring AI streaming chat
      chatClient
          .prompt(prompt)
          .stream()
          .content()
          .doOnNext(
              text -> {
                if (text != null && !text.isEmpty()) {
                  sink.tryEmitNext(new AgentEvent.DeltaEvent(text));
                }
              })
          .doOnComplete(
              () -> {
                metrics.recordAgentLatency(req.modelId(), System.currentTimeMillis() - startTime);
                sink.tryEmitNext(
                    new DoneEvent("final", newContinuationToken(), null, null));
                sink.tryEmitComplete();
              })
          .doOnError(
              err -> {
                metrics.recordAgentLatency(req.modelId(), System.currentTimeMillis() - startTime);
                LOG.error("Chat model call failed: {}", err.getMessage());
                sink.tryEmitNext(
                    new AgentEvent.ErrorEvent(50002, "Model upstream error", null));
                sink.tryEmitNext(
                    new DoneEvent("failed", null, null, null));
                sink.tryEmitComplete();
              })
          .subscribe();

    } catch (Exception e) {
      LOG.error("Chat loop error: {}", e.getMessage());
      sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
      sink.tryEmitNext(new DoneEvent("failed", null, null, null));
      sink.tryEmitComplete();
    }
  }

  /** Agent mode: multi-turn loop with plan/toolCall/result cycle. */
  private void runAgent(
      ChatClient chatClient,
      ConversationRequest req,
      AgentState state,
      int maxSteps,
      Sinks.Many<AgentEvent> sink,
      long startTime) {
    String toolsSchema = toolRouter.toolsSchemaJson();

    // Start the loop in a separate thread to avoid blocking the Flux.create thread
    Thread.ofVirtual()
        .name("agent-loop-" + req.sessionId())
        .start(
            () -> {
              try {
                while (state.steps() < maxSteps && !sink.isCancelled()) {
                  state.incrementSteps();

                  // 1. Assemble prompt
                  Prompt prompt = orchestrator.assemble(req, state, toolsSchema);
                  prompt = safeguardAdvisor.sanitize(prompt);

                  // 2. Call model (non-streaming for agent to get structured JSON)
                  String modelOutput;
                  try {
                    modelOutput =
                        chatClient
                            .prompt(prompt)
                            .call()
                            .content();
                  } catch (Exception e) {
                    LOG.error("Agent model call failed at step {}: {}", state.steps(), e.getMessage());
                    state.incrementConsecutiveFailures();
                    if (state.consecutiveFailures() >= 3) {
                      sink.tryEmitNext(
                          new AgentEvent.ErrorEvent(50002, "Model upstream error after 3 retries", null));
                      sink.tryEmitNext(new DoneEvent("failed", null, null, null));
                      break;
                    }
                    continue;
                  }

                  state.resetConsecutiveFailures();

                  // 3. Parse model response JSON
                  AgentTurn turn = parseTurn(modelOutput);

                  // 4. Emit events from the turn
                  if (turn.digest != null) {
                    sink.tryEmitNext(turn.digest);
                  }
                  if (turn.plan != null) {
                    sink.tryEmitNext(turn.plan);
                  }
                  if (turn.planDelta != null) {
                    sink.tryEmitNext(turn.planDelta);
                  }
                  if (turn.taskLedger != null) {
                    sink.tryEmitNext(turn.taskLedger);
                  }

                  // 5. Handle toolCall vs final
                  if (turn.finalAnswer != null) {
                    // Stream the final answer as deltas
                    sink.tryEmitNext(new AgentEvent.DeltaEvent(turn.finalAnswer));
                    sink.tryEmitNext(
                        new DoneEvent(
                            "final",
                            newContinuationToken(),
                            truncate(turn.finalAnswer, 400),
                            null));
                    break;
                  }

                  if (turn.toolCall != null) {
                    sink.tryEmitNext(turn.toolCall);
                    metrics.recordToolCall(turn.toolCall.name(), true);

                    // Wait for client tool result
                    String toolCallId = turn.toolCall.id();
                    Sinks.One<ToolResultRequest> resultSink =
                        toolRouter.registerPending(req.sessionId(), toolCallId);

                    // Emit tool_result_ack
                    sink.tryEmitNext(
                        new AgentEvent.ToolResultAckEvent(toolCallId, "waiting"));

                    // Block until result arrives (with timeout)
                    ToolResultRequest result;
                    try {
                      result =
                          resultSink
                              .asMono()
                              .block(TOOL_RESULT_TIMEOUT);
                    } catch (Exception e) {
                      LOG.error("Tool result timeout for {}", toolCallId);
                      state.incrementConsecutiveFailures();
                      continue;
                    }

                    if (result == null) {
                      LOG.warn("Tool result timed out for {}", toolCallId);
                      state.incrementConsecutiveFailures();
                      continue;
                    }

                    // Ack the result
                    sink.tryEmitNext(
                        new AgentEvent.ToolResultAckEvent(toolCallId, "received"));

                    // Add tool result to history for next turn
                    var history = new java.util.ArrayList<>(state.history());
                    history.add(new AssistantMessage(modelOutput));
                    history.add(
                        new UserMessage(
                            "Tool result for "
                                + toolCallId
                                + ": ok="
                                + result.ok()
                                + ", result="
                                + result.result()));
                    state.setHistory(history);
                    state.setEstimatedTokens(
                        state.estimatedTokens() + estimateTokens(modelOutput));

                    if (!result.ok()) {
                      state.incrementConsecutiveFailures();
                      if (state.consecutiveFailures() >= 3) {
                        sink.tryEmitNext(
                            new AgentEvent.ErrorEvent(
                                50001, "Tool execution failed 3 times in a row", null));
                        sink.tryEmitNext(
                            new DoneEvent("failed", null, null, null));
                        break;
                      }
                    } else {
                      state.resetConsecutiveFailures();
                    }
                    continue;
                  }

                  // No toolCall and no final — model gave an empty response, break
                  sink.tryEmitNext(new DoneEvent("final", newContinuationToken(), null, null));
                  break;
                }

                // Check max steps
                if (state.steps() >= maxSteps) {
                  sink.tryEmitNext(new DoneEvent("max_steps", newContinuationToken(), null, null));
                }

              } catch (Exception e) {
                LOG.error("Agent loop error: {}", e.getMessage(), e);
                sink.tryEmitNext(new AgentEvent.ErrorEvent(50001, e.getMessage(), null));
                sink.tryEmitNext(new DoneEvent("failed", null, null, null));
              } finally {
                metrics.recordAgentLatency(req.modelId(), System.currentTimeMillis() - startTime);
                sink.tryEmitComplete();
              }
            });
  }

  // ---- Parsing ----

  private AgentTurn parseTurn(String modelOutput) {
    AgentTurn turn = new AgentTurn();
    if (modelOutput == null || modelOutput.isBlank()) {
      return turn;
    }

    // Try to parse as JSON (agent mode structured output)
    try {
      JsonNode root = MAPPER.readTree(modelOutput);

      // digest
      if (root.has("digest") && !root.get("digest").isNull()) {
        turn.digest = MAPPER.treeToValue(root.get("digest"), AgentEvent.DigestEvent.class);
      }

      // plan
      if (root.has("plan") && !root.get("plan").isNull()) {
        turn.plan = new AgentEvent.PlanEvent(root.get("plan"));
      }

      // planDelta
      if (root.has("planDelta") && !root.get("planDelta").isNull()) {
        turn.planDelta = new AgentEvent.PlanDeltaEvent(root.get("planDelta"));
      }

      // taskLedger
      if (root.has("taskLedger") && !root.get("taskLedger").isNull()) {
        turn.taskLedger =
            MAPPER.treeToValue(root.get("taskLedger"), AgentEvent.TaskLedgerEvent.class);
      }

      // toolCall
      if (root.has("toolCall") && !root.get("toolCall").isNull()) {
        JsonNode tc = root.get("toolCall");
        turn.toolCall =
            new ToolCallEvent(
                tc.path("id").asText("tc-" + UUID.randomUUID()),
                tc.path("name").asText(),
                MAPPER.convertValue(tc.path("args"), Map.class),
                tc.path("riskLevel").asText("low"),
                tc.path("why").asText());
      }

      // final
      if (root.has("final") && !root.get("final").isNull()) {
        JsonNode f = root.get("final");
        turn.finalAnswer = f.path("answer").asText();
      }

    } catch (JsonProcessingException e) {
      // Not valid JSON — treat the entire output as a plain text answer
      LOG.debug("Model output not JSON, treating as plain text");
      turn.finalAnswer = modelOutput;
    }

    return turn;
  }

  private String newContinuationToken() {
    return UUID.randomUUID().toString();
  }

  private String truncate(String text, int maxChars) {
    if (text == null) return null;
    return text.length() <= maxChars ? text : text.substring(0, maxChars) + "...";
  }

  private long estimateTokens(String text) {
    if (text == null) return 0;
    return text.length() / 3L;
  }

  /** Parsed model response. */
  private static class AgentTurn {
    AgentEvent.DigestEvent digest;
    AgentEvent.PlanEvent plan;
    AgentEvent.PlanDeltaEvent planDelta;
    AgentEvent.TaskLedgerEvent taskLedger;
    ToolCallEvent toolCall;
    String finalAnswer;
  }
}
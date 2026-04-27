package io.codepilot.api.conversation;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.common.api.ApiResponse;
import io.codepilot.common.api.ErrorCodes;
import io.codepilot.common.api.TraceIdHolder;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.common.conversation.AgentEvent.DoneEvent;
import io.codepilot.common.conversation.AgentEvent.ErrorEvent;
import io.codepilot.common.conversation.ConversationRequest;
import io.codepilot.common.conversation.ConversationStopRequest;
import io.codepilot.core.agent.AgentLoop;
import io.codepilot.core.safety.SystemPromptLeakDetector;
import jakarta.validation.Valid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

/**
 * Unified conversation endpoint for both Chat and Agent modes.
 *
 * <p>Chat and Agent share the same endpoint ({@code /v1/conversation/run}); the {@code mode} field
 * in the request determines the PromptOrchestrator strategy and whether tool calls are allowed.
 *
 * <p>SSE events follow the design doc §3.2 specification.
 */
@RestController
@RequestMapping("/v1/conversation")
public class ConversationController {

  private static final Logger LOG = LoggerFactory.getLogger(ConversationController.class);
  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final SystemPromptLeakDetector LEAK_DETECTOR = new SystemPromptLeakDetector();

  private final AgentLoop agentLoop;

  public ConversationController(AgentLoop agentLoop) {
    this.agentLoop = agentLoop;
  }

  /**
   * Main conversation endpoint. Returns SSE stream of {@link AgentEvent}s.
   *
   * <p>Event ordering:
   *
   * <ul>
   *   <li>Chat: (digest?) → delta* → usage → done
   *   <li>Agent: (digest?) → (task_ledger?) → (plan|plan_delta) → (risk_notice?) →
   *       (tool_call|delta) → (tool_result_ack) → (self_check?) → repeat until done
   * </ul>
   */
  @PostMapping(value = "/run", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> run(@RequestBody @Valid ConversationRequest req) {
    // Pre-call safety check on user input
    var leakVerdict = LEAK_DETECTOR.detect(req.input());
    if (leakVerdict.blocked()) {
      LOG.warn("System prompt leak attempt detected: rule={}", leakVerdict.matchedRule());
      return Flux.just(
          sse(
              "error",
              new ErrorEvent(
                  ErrorCodes.SYSTEM_PROMPT_LEAK,
                  "Input blocked by safety policy",
                  TraceIdHolder.current())),
          sse("done", new DoneEvent("final", null, null, null)));
    }

    // Also check freeform answers
    if (req.answers() != null) {
      for (var answer : req.answers()) {
        if (answer.freeform() != null) {
          var ansVerdict = LEAK_DETECTOR.detect(answer.freeform());
          if (ansVerdict.blocked()) {
            return Flux.just(
                sse(
                    "error",
                    new ErrorEvent(
                        ErrorCodes.SYSTEM_PROMPT_LEAK,
                        "Answer blocked by safety policy",
                        TraceIdHolder.current())),
                sse("done", new DoneEvent("final", null, null, null)));
          }
        }
      }
    }

    LOG.info(
        "conversation/run sessionId={} mode={} intent={}",
        req.sessionId(),
        req.mode(),
        req.intent());

    return agentLoop
        .run(req)
        .map(
            event -> {
              String eventName = event.type();
              try {
                String json = MAPPER.writeValueAsString(event);
                return ServerSentEvent.<String>builder().event(eventName).data(json).build();
              } catch (Exception e) {
                LOG.error("Failed to serialize event: {}", e.getMessage());
                return ServerSentEvent.<String>builder()
                    .event("error")
                    .data("{\"code\":50001,\"message\":\"Serialization error\"}")
                    .build();
              }
            });
  }

  /** Stop the current agent run. */
  @PostMapping("/stop")
  public Flux<ApiResponse<Void>> stop(@RequestBody @Valid ConversationStopRequest req) {
    LOG.info("conversation/stop sessionId={}", req.sessionId());
    // For M3, stop is handled by client-side SSE cancellation.
    // The AgentLoop checks sink.isCancelled() on each iteration.
    return Flux.just(ApiResponse.ok(null));
  }

  private ServerSentEvent<String> sse(String event, Object data) {
    try {
      return ServerSentEvent.<String>builder()
          .event(event)
          .data(MAPPER.writeValueAsString(data))
          .build();
    } catch (Exception e) {
      return ServerSentEvent.<String>builder()
          .event("error")
          .data("{\"code\":50001,\"message\":\"Serialization error\"}")
          .build();
    }
  }
}
package io.codepilot.api.conversation;

import io.codepilot.common.api.ApiResponse;
import io.codepilot.common.conversation.ToolResultRequest;
import io.codepilot.core.tool.ToolRouter;
import jakarta.validation.Valid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

/**
 * Receives tool execution results from the plugin after a client-side tool call.
 *
 * <p>Per §3.3 of the API spec: the plugin executes the tool locally and posts the result back so
 * the agent loop can continue.
 */
@RestController
@RequestMapping(
    value = "/v1/conversation",
    produces = MediaType.APPLICATION_JSON_VALUE,
    consumes = MediaType.APPLICATION_JSON_VALUE)
public class ToolResultController {

  private static final Logger LOG = LoggerFactory.getLogger(ToolResultController.class);

  private final ToolRouter toolRouter;

  public ToolResultController(ToolRouter toolRouter) {
    this.toolRouter = toolRouter;
  }

  @PostMapping("/tool-result")
  public Mono<ApiResponse<Void>> toolResult(@RequestBody @Valid ToolResultRequest req) {
    LOG.info(
        "tool-result sessionId={} toolCallId={} ok={}",
        req.sessionId(),
        req.toolCallId(),
        req.ok());

    boolean matched = toolRouter.completeResult(req);
    if (!matched) {
      LOG.warn("No pending tool result sink for sessionId={} toolCallId={}", req.sessionId(), req.toolCallId());
    }

    return Mono.just(ApiResponse.ok(null));
  }
}
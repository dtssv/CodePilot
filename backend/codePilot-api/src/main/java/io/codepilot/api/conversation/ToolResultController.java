package io.codepilot.api.conversation;

import io.codepilot.common.api.ApiResponse;
import io.codepilot.core.conversation.ToolResultBus;
import io.codepilot.core.conversation.ToolResultBus.ToolResultEvent;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

/**
 * Receives client-side tool results (file ops, shell, MCP) and re-publishes them onto the
 * tool-result bus for the in-flight {@code /v1/conversation/run} stream.
 */
@RestController
@RequestMapping(
    value = "/v1/conversation",
    produces = MediaType.APPLICATION_JSON_VALUE,
    consumes = MediaType.APPLICATION_JSON_VALUE)
public class ToolResultController {

  private final ToolResultBus bus;

  public ToolResultController(ToolResultBus bus) {
    this.bus = bus;
  }

  @PostMapping("/tool-result")
  public Mono<ApiResponse<Ack>> toolResult(@RequestBody @Valid Request req) {
    ToolResultEvent event =
        new ToolResultEvent(
            req.toolCallId(),
            req.ok(),
            req.result(),
            req.errorCode(),
            req.errorMessage(),
            req.durationMs() == null ? 0 : req.durationMs());
    return bus.publish(req.sessionId(), event)
        .map(received -> ApiResponse.ok(new Ack(req.toolCallId(), "received")));
  }

  public record Request(
      @NotBlank String sessionId,
      @NotBlank String toolCallId,
      Boolean ok,
      Object result,
      String errorCode,
      String errorMessage,
      Long durationMs) {

    public boolean ok() {
      return ok != null && ok;
    }
  }

  public record Ack(String toolCallId, String status) {}
}
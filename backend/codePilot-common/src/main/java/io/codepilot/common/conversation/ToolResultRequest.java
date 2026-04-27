package io.codepilot.common.conversation;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.NotBlank;
import java.util.Map;

/**
 * Request for {@code POST /v1/conversation/tool-result}. Plugin executes a client-side tool and
 * posts the result back so the agent loop can continue.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ToolResultRequest(
    @NotBlank String sessionId,
    @NotBlank String toolCallId,
    boolean ok,
    Map<String, Object> result,
    Long durationMs) {

  public ToolResultRequest {
    if (durationMs == null) durationMs = 0L;
  }
}
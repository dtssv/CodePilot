package io.codepilot.api.session;

import io.codepilot.common.api.ApiResponse;
import io.codepilot.core.session.SessionService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Session utility endpoints (not part of the main Agent flow). */
@Tag(name = "session", description = "Session utilities: title generation and digest")
@RestController
@RequestMapping(value = "/v1/session", produces = MediaType.APPLICATION_JSON_VALUE)
public class SessionController {

  private final SessionService sessionService;

  public SessionController(SessionService sessionService) {
    this.sessionService = sessionService;
  }

  /** Ask the model to generate a short title for a conversation. */
  @Operation(summary = "Generate a conversation title via LLM")
  @PostMapping(value = "/title", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, String>> generateTitle(@RequestBody @Valid TitleRequest req) {
    String title = sessionService.generateTitle(req.sessionId(), req.firstMessage());
    return ApiResponse.ok(Map.of("title", title));
  }

  /** Standalone digest: summarise session history (not used inside Agent). */
  @Operation(summary = "Generate a standalone session digest")
  @PostMapping(value = "/digest", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, String>> digest(@RequestBody @Valid DigestRequest req) {
    String digest = sessionService.generateDigest(req.sessionId(), req.history());
    return ApiResponse.ok(Map.of("digest", digest));
  }

  // ---- Request DTOs ---- //

  public record TitleRequest(@NotNull UUID sessionId, @NotBlank String firstMessage) {}

  public record DigestRequest(@NotNull UUID sessionId, @NotBlank String history) {}
}

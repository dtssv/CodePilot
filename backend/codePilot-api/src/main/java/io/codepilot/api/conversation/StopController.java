package io.codepilot.api.conversation;

import io.codepilot.common.api.ApiResponse;
import io.codepilot.core.conversation.StopSignalBus;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

/** Requests cancellation of an in-flight conversation run by session id. */
@RestController
@RequestMapping(
    value = "/v1/conversation",
    produces = MediaType.APPLICATION_JSON_VALUE,
    consumes = MediaType.APPLICATION_JSON_VALUE)
public class StopController {

  private final StopSignalBus bus;

  public StopController(StopSignalBus bus) {
    this.bus = bus;
  }

  @PostMapping("/stop")
  public Mono<ApiResponse<Void>> stop(@RequestBody @Valid Request req) {
    return bus.stop(req.sessionId()).thenReturn(ApiResponse.ok(null));
  }

  public record Request(@NotBlank String sessionId) {}
}
package io.codepilot.api.conversation;

import io.codepilot.core.conversation.ConversationService;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.safety.SystemPromptLeakOutputFilter;
import jakarta.validation.Valid;
import java.time.Duration;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

/**
 * Unified conversation endpoint for both chat and agent modes.
 *
 * <p>The response body is an SSE stream; the events and their payloads are documented in
 * docs/05-接口文档.md §3.2.
 */
@RestController
@RequestMapping(value = "/v1/conversation")
public class ConversationController {

  private final ConversationService service;
  private final SystemPromptLeakOutputFilter leakOutputFilter;

  public ConversationController(
      ConversationService service, SystemPromptLeakOutputFilter leakOutputFilter) {
    this.service = service;
    this.leakOutputFilter = leakOutputFilter;
  }

  @PostMapping(
      value = "/run",
      consumes = MediaType.APPLICATION_JSON_VALUE,
      produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> run(@RequestBody @Valid ConversationRunRequest req) {
    Flux<ServerSentEvent<String>> raw = service.run(req);
    // Periodic heartbeats (SSE comment) keep long-lived proxies from idle-closing the stream.
    Flux<ServerSentEvent<String>> heartbeat =
        Flux.interval(Duration.ofSeconds(20))
            .map(i -> ServerSentEvent.<String>builder().comment("keep-alive " + i).build());
    return leakOutputFilter
        .guard(raw)
        .mergeWith(heartbeat.takeUntilOther(raw.ignoreElements()));
  }
}
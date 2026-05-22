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
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

/**
 * Resumes an agent session with the plugin-side plan / completed tool calls / digest carried in
 * the request. Same stream shape as {@code /v1/conversation/run}.
 *
 * <p>If the request includes a {@code continuationToken}, the graph engine will load the
 * saved checkpoint from Redis and resume execution from the interrupt point's next node,
 * injecting the user's answers into the restored state.
 *
 * <p>Without a {@code continuationToken}, this falls back to starting a new graph run
 * (legacy behavior for backward compatibility).
 */
@RestController
@RequestMapping(value = "/v1/conversation")
public class ResumeController {

  private final ConversationService service;
  private final ConversationRunGate runGate;
  private final ConversationQueuedOrchestrator queuedOrchestrator;
  private final SystemPromptLeakOutputFilter leakFilter;

  public ResumeController(
      ConversationService service,
      ConversationRunGate runGate,
      ConversationQueuedOrchestrator queuedOrchestrator,
      SystemPromptLeakOutputFilter leakFilter) {
    this.service = service;
    this.runGate = runGate;
    this.queuedOrchestrator = queuedOrchestrator;
    this.leakFilter = leakFilter;
  }

  @PostMapping(
      value = "/resume",
      consumes = MediaType.APPLICATION_JSON_VALUE,
      produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> resume(
      @RequestHeader(value = "X-User-Id", required = false) String userId,
      @RequestBody @Valid ConversationRunRequest req) {
    // Delegate to ConversationService.resume() which checks continuationToken
    // and routes to graphEngine.resume() or graphEngine.run() accordingly
    // ★ share() + heartbeat — same pattern as ConversationController.run()
    // to prevent proxy idle-close and double-subscription issues during resume.
    Flux<ServerSentEvent<String>> raw =
        (runGate.useQueue(req) ? queuedOrchestrator.run(req, userId) : service.resume(req, userId))
            .share();
    Flux<ServerSentEvent<String>> heartbeat =
        Flux.interval(Duration.ofSeconds(20))
            .map(i -> ServerSentEvent.<String>builder().comment("keep-alive " + i).build());
    return leakFilter
        .guard(raw)
        .mergeWith(heartbeat.takeUntilOther(raw.ignoreElements()));
  }
}
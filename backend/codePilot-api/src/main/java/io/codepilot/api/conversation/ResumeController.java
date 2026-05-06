package io.codepilot.api.conversation;

import io.codepilot.core.conversation.ConversationService;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.safety.SystemPromptLeakOutputFilter;
import jakarta.validation.Valid;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

/**
 * Resumes an agent session with the plugin-side plan / completed tool calls / digest carried in
 * the request. Same stream shape as {@code /v1/conversation/run}.
 */
@RestController
@RequestMapping(value = "/v1/conversation")
public class ResumeController {

  private final ConversationService service;
  private final SystemPromptLeakOutputFilter leakFilter;

  public ResumeController(ConversationService service, SystemPromptLeakOutputFilter leakFilter) {
    this.service = service;
    this.leakFilter = leakFilter;
  }

  @PostMapping(
      value = "/resume",
      consumes = MediaType.APPLICATION_JSON_VALUE,
      produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> resume(@RequestBody @Valid ConversationRunRequest req) {
    return leakFilter.guard(service.run(req));
  }
}
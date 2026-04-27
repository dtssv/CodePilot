package io.codepilot.api.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.core.action.ActionService;
import io.codepilot.core.action.ActionService.ActionType;
import io.codepilot.api.util.SseHelper;
import jakarta.validation.Valid;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

/**
 * REST controller for one-shot action endpoints.
 *
 * <p>All actions return SSE streams with events: delta / patch / usage / error / done.
 *
 * <ul>
 *   <li>{@code POST /v1/actions/refactor} — refactor selected code</li>
 *   <li>{@code POST /v1/actions/review}   — code review</li>
 *   <li>{@code POST /v1/actions/comment}  — add documentation comments</li>
 *   <li>{@code POST /v1/actions/gentest}  — generate unit tests</li>
 *   <li>{@code POST /v1/actions/gendoc}   — generate documentation</li>
 * </ul>
 */
@RestController
@RequestMapping("/v1/actions")
public class ActionController {

  private static final String SSE_EVENT_TYPE = "text/event-stream";

  private final ActionService actionService;

  public ActionController(ActionService actionService) {
    this.actionService = actionService;
  }

  /** POST /v1/actions/refactor — refactor selected code. */
  @PostMapping(value = "/refactor", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> refactor(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.REFACTOR, req));
  }

  /** POST /v1/actions/review — code review. */
  @PostMapping(value = "/review", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> review(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.REVIEW, req));
  }

  /** POST /v1/actions/comment — add documentation comments. */
  @PostMapping(value = "/comment", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> comment(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.COMMENT, req));
  }

  /** POST /v1/actions/gentest — generate unit tests. */
  @PostMapping(value = "/gentest", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> gentest(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.GENTEST, req));
  }

  /** POST /v1/actions/gendoc — generate documentation. */
  @PostMapping(value = "/gendoc", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> gendoc(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.GENDOC, req));
  }

  /** Converts AgentEvent Flux to SSE Flux. */
  private Flux<ServerSentEvent<String>> toSse(Flux<AgentEvent> events) {
    return SseHelper.toSse(events);
  }
}package io.codepilot.api.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.core.action.ActionService;
import io.codepilot.core.action.ActionService.ActionType;
import jakarta.validation.Valid;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

/**
 * REST controller for one-shot action endpoints.
 *
 * <p>All actions return SSE streams with events: delta / patch / usage / error / done.
 *
 * <ul>
 *   <li>{@code POST /v1/actions/refactor} — refactor selected code</li>
 *   <li>{@code POST /v1/actions/review}   — code review</li>
 *   <li>{@code POST /v1/actions/comment}  — add documentation comments</li>
 *   <li>{@code POST /v1/actions/gentest}  — generate unit tests</li>
 *   <li>{@code POST /v1/actions/gendoc}   — generate documentation</li>
 * </ul>
 */
@RestController
@RequestMapping("/v1/actions")
public class ActionController {

  private static final String SSE_EVENT_TYPE = "text/event-stream";

  private final ActionService actionService;

  public ActionController(ActionService actionService) {
    this.actionService = actionService;
  }

  /** POST /v1/actions/refactor — refactor selected code. */
  @PostMapping(value = "/refactor", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> refactor(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.REFACTOR, req));
  }

  /** POST /v1/actions/review — code review. */
  @PostMapping(value = "/review", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> review(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.REVIEW, req));
  }

  /** POST /v1/actions/comment — add documentation comments. */
  @PostMapping(value = "/comment", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> comment(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.COMMENT, req));
  }

  /** POST /v1/actions/gentest — generate unit tests. */
  @PostMapping(value = "/gentest", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> gentest(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.GENTEST, req));
  }

  /** POST /v1/actions/gendoc — generate documentation. */
  @PostMapping(value = "/gendoc", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> gendoc(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.GENDOC, req));
  }

  /** Converts AgentEvent Flux to SSE Flux. */
  private Flux<ServerSentEvent<String>> toSse(Flux<AgentEvent> events) {
    return SseHelper.toSse(events);
  }
}package io.codepilot.api.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.core.action.ActionService;
import io.codepilot.core.action.ActionService.ActionType;
import io.codepilot.api.util.SseHelper;
import jakarta.validation.Valid;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

/**
 * REST controller for one-shot action endpoints.
 *
 * <p>All actions return SSE streams with events: delta / patch / usage / error / done.
 *
 * <ul>
 *   <li>{@code POST /v1/actions/refactor} — refactor selected code</li>
 *   <li>{@code POST /v1/actions/review}   — code review</li>
 *   <li>{@code POST /v1/actions/comment}  — add documentation comments</li>
 *   <li>{@code POST /v1/actions/gentest}  — generate unit tests</li>
 *   <li>{@code POST /v1/actions/gendoc}   — generate documentation</li>
 * </ul>
 */
@RestController
@RequestMapping("/v1/actions")
public class ActionController {

  private static final String SSE_EVENT_TYPE = "text/event-stream";

  private final ActionService actionService;

  public ActionController(ActionService actionService) {
    this.actionService = actionService;
  }

  /** POST /v1/actions/refactor — refactor selected code. */
  @PostMapping(value = "/refactor", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> refactor(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.REFACTOR, req));
  }

  /** POST /v1/actions/review — code review. */
  @PostMapping(value = "/review", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> review(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.REVIEW, req));
  }

  /** POST /v1/actions/comment — add documentation comments. */
  @PostMapping(value = "/comment", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> comment(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.COMMENT, req));
  }

  /** POST /v1/actions/gentest — generate unit tests. */
  @PostMapping(value = "/gentest", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> gentest(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.GENTEST, req));
  }

  /** POST /v1/actions/gendoc — generate documentation. */
  @PostMapping(value = "/gendoc", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> gendoc(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.GENDOC, req));
  }

  /** Converts AgentEvent Flux to SSE Flux. */
  private Flux<ServerSentEvent<String>> toSse(Flux<AgentEvent> events) {
    return events.map(event -> ServerSentEvent.<String>builder()
        .event(event.type())
        .data(io.codepilot.api.conversation.ConversationController.toJson(event))
        .build());
  }
}package io.codepilot.api.action;

import io.codepilot.common.action.ActionRequest;
import io.codepilot.common.conversation.AgentEvent;
import io.codepilot.core.action.ActionService;
import io.codepilot.core.action.ActionService.ActionType;
import jakarta.validation.Valid;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

/**
 * REST controller for one-shot action endpoints.
 *
 * <p>All actions return SSE streams with events: delta / patch / usage / error / done.
 *
 * <ul>
 *   <li>{@code POST /v1/actions/refactor} — refactor selected code</li>
 *   <li>{@code POST /v1/actions/review}   — code review</li>
 *   <li>{@code POST /v1/actions/comment}  — add documentation comments</li>
 *   <li>{@code POST /v1/actions/gentest}  — generate unit tests</li>
 *   <li>{@code POST /v1/actions/gendoc}   — generate documentation</li>
 * </ul>
 */
@RestController
@RequestMapping("/v1/actions")
public class ActionController {

  private static final String SSE_EVENT_TYPE = "text/event-stream";

  private final ActionService actionService;

  public ActionController(ActionService actionService) {
    this.actionService = actionService;
  }

  /** POST /v1/actions/refactor — refactor selected code. */
  @PostMapping(value = "/refactor", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> refactor(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.REFACTOR, req));
  }

  /** POST /v1/actions/review — code review. */
  @PostMapping(value = "/review", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> review(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.REVIEW, req));
  }

  /** POST /v1/actions/comment — add documentation comments. */
  @PostMapping(value = "/comment", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> comment(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.COMMENT, req));
  }

  /** POST /v1/actions/gentest — generate unit tests. */
  @PostMapping(value = "/gentest", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> gentest(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.GENTEST, req));
  }

  /** POST /v1/actions/gendoc — generate documentation. */
  @PostMapping(value = "/gendoc", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> gendoc(@Valid @RequestBody ActionRequest req) {
    return toSse(actionService.execute(ActionType.GENDOC, req));
  }

  /** Converts AgentEvent Flux to SSE Flux. */
  private Flux<ServerSentEvent<String>> toSse(Flux<AgentEvent> events) {
    return events.map(event -> ServerSentEvent.<String>builder()
        .event(event.type())
        .data(io.codepilot.api.conversation.ConversationController.toJson(event))
        .build());
  }
}
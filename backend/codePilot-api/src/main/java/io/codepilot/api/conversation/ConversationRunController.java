package io.codepilot.api.conversation;

import io.codepilot.common.api.ApiResponse;
import java.time.Duration;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

/** Attach to a durable conversation run (replay + live). */
@RestController
@RequestMapping(value = "/v1/conversation/runs", produces = MediaType.APPLICATION_JSON_VALUE)
public class ConversationRunController {

  private final ConversationQueuedOrchestrator orchestrator;
  private final ConversationRunStore store;

  public ConversationRunController(
      ConversationQueuedOrchestrator orchestrator, ConversationRunStore store) {
    this.orchestrator = orchestrator;
    this.store = store;
  }

  @GetMapping(value = "/{runId}/status")
  public ApiResponse<Map<String, Object>> status(@PathVariable String runId) {
    return ApiResponse.ok(store.statusMap(runId));
  }

  @GetMapping(value = "/{runId}/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public Flux<ServerSentEvent<String>> stream(
      @PathVariable String runId,
      @RequestParam(defaultValue = "0") int afterSeq) {
    Flux<ServerSentEvent<String>> raw = orchestrator.attach(runId, afterSeq);
    Flux<ServerSentEvent<String>> heartbeat =
        Flux.interval(Duration.ofSeconds(20))
            .map(i -> ServerSentEvent.<String>builder().comment("keep-alive " + i).build());
    return raw.mergeWith(heartbeat.takeUntilOther(raw.ignoreElements()));
  }
}

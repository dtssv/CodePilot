package io.codepilot.api.conversation;

import io.codepilot.common.api.ErrorCodes;
import io.codepilot.core.conversation.SseFactory;
import io.codepilot.core.run.ConversationRunAdmissionService;
import io.codepilot.core.run.ConversationRunEventBus;
import io.codepilot.core.run.ConversationRunEventBus.RunEventMessage;
import io.codepilot.core.run.ConversationRunStatus;
import io.codepilot.core.sse.SseEvents;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/** Enqueues agent runs, streams persisted + live events (P2b). */
@Service
public class ConversationQueuedOrchestrator {

  private static final Logger log = LoggerFactory.getLogger(ConversationQueuedOrchestrator.class);

  private final ConversationRunStore store;
  private final ConversationRunWorker worker;
  private final ConversationRunEventBus eventBus;
  private final SseFactory sse;
  private final ConversationRunAdmissionService admission;

  public ConversationQueuedOrchestrator(
      ConversationRunStore store,
      ConversationRunWorker worker,
      ConversationRunEventBus eventBus,
      SseFactory sse,
      ConversationRunAdmissionService admission) {
    this.store = store;
    this.worker = worker;
    this.eventBus = eventBus;
    this.sse = sse;
    this.admission = admission;
  }

  public Flux<ServerSentEvent<String>> run(io.codepilot.core.dto.ConversationRunRequest req, String userId) {
    String uid = userId != null && !userId.isBlank() ? userId : "dev-user";
    return admission
        .tryAdmitEnqueue(uid)
        .flatMapMany(
            decision -> {
              if (!decision.allowed()) {
                log.warn(
                    "Admission rejected enqueue sessionId={} userId={}",
                    req.sessionId(),
                    uid);
                return Flux.just(
                    sse.error(
                        decision.errorCode() > 0 ? decision.errorCode() : ErrorCodes.QUEUE_FULL,
                        decision.message()),
                    sse.event(SseEvents.DONE, Map.of("reason", "failed")));
              }
              String runId = UUID.randomUUID().toString();
              String requestJson = store.serializeRequest(req);
              try {
                store.insertRun(runId, req.sessionId(), uid, requestJson, ConversationRunStatus.QUEUED);
              } catch (Exception e) {
                admission.releaseQueued(uid).subscribe();
                return Flux.just(
                    sse.error(ErrorCodes.INTERNAL, "Failed to enqueue run"),
                    sse.event(SseEvents.DONE, Map.of("reason", "failed")));
              }
              log.info("Enqueued conversation run runId={} sessionId={}", runId, req.sessionId());
              worker.startIfClaimed(runId);
              return streamRun(runId, 0, true);
            });
  }

  public Flux<ServerSentEvent<String>> attach(String runId, int afterSeq) {
    var row = store.get(runId);
    if (row.isEmpty()) {
      return Flux.just(
          sse.error(40401, "Run not found: " + runId),
          sse.event(SseEvents.DONE, Map.of("reason", "failed")));
    }
    if (ConversationRunStatus.INTERRUPTED.equals(row.get().status())
        || ConversationRunStatus.QUEUED.equals(row.get().status())) {
      worker.startIfClaimed(runId);
    }
    boolean reclaimed =
        ConversationRunStatus.INTERRUPTED.equals(row.get().status())
            || ConversationRunStatus.QUEUED.equals(row.get().status());
    return streamRun(runId, afterSeq, reclaimed);
  }

  private Flux<ServerSentEvent<String>> streamRun(String runId, int afterSeq, boolean emitMeta) {
    List<ConversationRunStore.RunEvent> history = store.loadEventRecordsSince(runId, afterSeq);
    int maxReplaySeq =
        history.stream().mapToInt(ConversationRunStore.RunEvent::seq).max().orElse(afterSeq);

    Flux<ServerSentEvent<String>> replay =
        Flux.fromIterable(history).map(ConversationRunStore.RunEvent::toSse);

    Flux<ServerSentEvent<String>> meta =
        emitMeta
            ? Flux.just(
                sse.event(
                    SseEvents.RUN_STARTED,
                    Map.of("runId", runId, "afterSeq", afterSeq)))
            : Flux.empty();

    boolean showReclaimed =
        emitMeta
            && store
                .get(runId)
                .map(
                    r ->
                        ConversationRunStatus.INTERRUPTED.equals(r.status())
                            || ConversationRunStatus.QUEUED.equals(r.status()))
                .orElse(false);

    Flux<ServerSentEvent<String>> reclaimed =
        showReclaimed
            ? Flux.just(
                sse.event(
                    SseEvents.RUN_RECLAIMED,
                    Map.of("runId", runId, "message", "Run reclaimed after deploy interrupt")))
            : Flux.empty();

  final int minLiveSeq = maxReplaySeq;
    Flux<ServerSentEvent<String>> live =
        eventBus
            .subscribe(runId, minLiveSeq)
            .map(RunEventMessage::toSse);

    return Flux.concat(meta, reclaimed, replay, live).takeUntil(ev -> SseEvents.DONE.equals(ev.event()));
  }
}

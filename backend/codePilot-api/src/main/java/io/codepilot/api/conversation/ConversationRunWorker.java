package io.codepilot.api.conversation;

import io.codepilot.core.conversation.ConversationService;
import io.codepilot.core.conversation.SseFactory;
import io.codepilot.core.deploy.DeployDrainService;
import io.codepilot.core.dto.ConversationMode;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.run.ConversationRunAdmissionProperties;
import io.codepilot.core.run.ConversationRunAdmissionService;
import io.codepilot.core.run.ConversationRunEventBus;
import io.codepilot.core.run.ConversationRunProperties;
import io.codepilot.core.run.ConversationRunStatus;
import io.codepilot.core.run.WorkerIdentity;
import io.codepilot.core.sse.SseEvents;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import reactor.core.Disposable;
import reactor.core.publisher.Flux;
import reactor.core.scheduler.Schedulers;

/** Executes a durable run and mirrors SSE to DB + Redis. */
@Component
public class ConversationRunWorker {

  private static final Logger log = LoggerFactory.getLogger(ConversationRunWorker.class);

  private final ConversationService conversationService;
  private final ConversationRunStore store;
  private final ConversationRunEventBus eventBus;
  private final ConversationRunProperties properties;
  private final WorkerIdentity workerIdentity;
  private final SseFactory sse;
  private final ConversationRunAdmissionService admission;
  private final Semaphore executionSlots;
  private final ConcurrentHashMap<String, Disposable> active = new ConcurrentHashMap<>();

  public ConversationRunWorker(
      ConversationService conversationService,
      ConversationRunStore store,
      ConversationRunEventBus eventBus,
      ConversationRunProperties properties,
      WorkerIdentity workerIdentity,
      SseFactory sse,
      ConversationRunAdmissionService admission,
      ConversationRunAdmissionProperties admissionProperties) {
    this.conversationService = conversationService;
    this.store = store;
    this.eventBus = eventBus;
    this.properties = properties;
    this.workerIdentity = workerIdentity;
    this.sse = sse;
    this.admission = admission;
    int slots = Math.max(1, admissionProperties.getMaxWorkerConcurrent());
    this.executionSlots = new Semaphore(slots);
  }

  public boolean isExecuting(String runId) {
    return active.containsKey(runId);
  }

  public void startIfClaimed(String runId) {
    if (!store.isDbBacked()) return;
    if (active.containsKey(runId)) return;
    if (!executionSlots.tryAcquire()) {
      log.debug("Worker at capacity — deferring runId={}", runId);
      return;
    }
    Instant leaseUntil = Instant.now().plus(properties.getLeaseDuration());
    if (!store.tryClaim(runId, workerIdentity.id(), leaseUntil)) {
      executionSlots.release();
      return;
    }
    log.info("ConversationRunWorker claimed runId={} worker={}", runId, workerIdentity.id());
    Disposable d =
        Schedulers.boundedElastic()
            .schedule(
                () -> {
                  try {
                    execute(runId);
                  } finally {
                    active.remove(runId);
                    executionSlots.release();
                  }
                });
    active.put(runId, d);
  }

  public void execute(String runId) {
    var rowOpt = store.get(runId);
    if (rowOpt.isEmpty()) return;
    var row = rowOpt.get();
    String userId = row.userId() != null ? row.userId() : "dev-user";
    String statusAtStart = row.status() != null ? row.status() : "";
    boolean incrAdmissionOnStart =
        ConversationRunStatus.QUEUED.equals(statusAtStart)
            || ConversationRunStatus.INTERRUPTED.equals(statusAtStart);
    boolean decrAdmissionOnFinish =
        incrAdmissionOnStart || ConversationRunStatus.RUNNING.equals(statusAtStart);
    if (incrAdmissionOnStart) {
      admission.onRunStarted(userId).block();
    }
    AtomicInteger seq = new AtomicInteger(row.lastSeq());
    AtomicBoolean terminal = new AtomicBoolean(false);

    ConversationRunRequest base = store.deserializeRequest(row.requestJson());
    ConversationRunRequest req = base;
    if (row.continuationToken() != null && !row.continuationToken().isBlank()) {
      req =
          new ConversationRunRequest(
              base.sessionId(),
              base.mode(),
              base.modelId(),
              base.modelSource(),
              base.input(),
              ConversationRunRequest.Intent.CONTINUE,
              row.continuationToken(),
              base.answers(),
              base.taskLedger(),
              base.lastPlanDigest(),
              base.lastAssistantTurnSummary(),
              base.sessionDigest(),
              base.contexts(),
              base.tools(),
              base.completedToolCallsTail(),
              base.earlierToolCallsCount(),
              base.projectRootHash(),
              base.userSkills(),
              base.userSkillRefs(),
              base.userSkillBodies(),
              base.userMcps(),
              base.mcpTools(),
              base.userPlanEdits(),
              base.options(),
              base.policy(),
              base.skills(),
              base.projectRules(),
              base.images(),
              base.graphState(),
              base.projectMeta());
    }

    Flux<ServerSentEvent<String>> flux;
    if (req.mode() == ConversationMode.AGENT
        && req.continuationToken() != null
        && !req.continuationToken().isBlank()) {
      flux = conversationService.resume(req, row.userId());
    } else {
      flux = conversationService.run(req, row.userId());
    }

    Disposable leaseRenew =
        Flux.interval(properties.getLeaseDuration().dividedBy(2))
            .subscribe(
                i ->
                    store.renewLease(
                        runId,
                        workerIdentity.id(),
                        Instant.now().plus(properties.getLeaseDuration())));

    try {
      flux.doOnNext(
              event -> {
                if (terminal.get()) return;
                int next = seq.incrementAndGet();
                store.appendEvent(runId, next, event);
                eventBus.publish(runId, next, event).subscribe();
                if (SseEvents.DONE.equals(event.event())) {
                  terminal.set(true);
                  String reason = parseDoneReason(event.data());
                  if ("awaiting_user_input".equals(reason)) {
                    store.updateStatus(runId, ConversationRunStatus.AWAITING_INPUT, extractToken(event.data()));
                  } else if (DeployDrainService.DONE_REASON_DEPLOY_DRAINING.equals(reason)) {
                    store.markInterrupted(runId, extractToken(event.data()));
                  } else if ("failed".equals(reason) || "error".equals(reason)) {
                    store.updateStatus(runId, ConversationRunStatus.FAILED, null);
                  } else {
                    store.updateStatus(runId, ConversationRunStatus.COMPLETED, null);
                  }
                }
              })
          .doOnError(
              err -> {
                log.warn("Run {} failed: {}", runId, err.getMessage());
                store.fail(runId, err.getMessage());
                int next = seq.incrementAndGet();
                var errEv = sse.error(50001, err.getMessage());
                store.appendEvent(runId, next, errEv);
                eventBus.publish(runId, next, errEv).subscribe();
                int doneSeq = seq.incrementAndGet();
                var doneEv = sse.event(SseEvents.DONE, Map.of("reason", "failed"));
                store.appendEvent(runId, doneSeq, doneEv);
                eventBus.publish(runId, doneSeq, doneEv).subscribe();
              })
          .blockLast();
    } catch (Exception e) {
      log.warn("Run {} execution error: {}", runId, e.getMessage());
      store.fail(runId, e.getMessage());
    } finally {
      leaseRenew.dispose();
      if (decrAdmissionOnFinish) {
        admission.onRunFinished(userId).block();
      }
    }
  }

  public void cancelLocal(String runId) {
    Disposable d = active.remove(runId);
    if (d != null) {
      d.dispose();
    }
  }

  private static String parseDoneReason(String data) {
    if (data == null) return "final";
    try {
      if (data.contains("\"reason\"")) {
        int i = data.indexOf("\"reason\"");
        int colon = data.indexOf(':', i);
        int q1 = data.indexOf('"', colon + 1);
        int q2 = data.indexOf('"', q1 + 1);
        if (q1 >= 0 && q2 > q1) return data.substring(q1 + 1, q2);
      }
    } catch (Exception ignored) {
    }
    return "final";
  }

  private static String extractToken(String data) {
    if (data == null) return null;
    try {
      if (data.contains("\"continuationToken\"")) {
        int i = data.indexOf("\"continuationToken\"");
        int colon = data.indexOf(':', i);
        int q1 = data.indexOf('"', colon + 1);
        int q2 = data.indexOf('"', q1 + 1);
        if (q1 >= 0 && q2 > q1) return data.substring(q1 + 1, q2);
      }
    } catch (Exception ignored) {
    }
    return null;
  }
}

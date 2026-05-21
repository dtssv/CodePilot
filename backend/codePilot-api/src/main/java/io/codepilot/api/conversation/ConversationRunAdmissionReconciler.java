package io.codepilot.api.conversation;

import io.codepilot.core.run.ConversationRunAdmissionProperties;
import io.codepilot.core.run.ConversationRunAdmissionService;
import java.util.HashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

/** Keeps Redis admission counters aligned with {@code conversation_runs} (crash / reclaim drift). */
@Component
public class ConversationRunAdmissionReconciler {

  private static final Logger log = LoggerFactory.getLogger(ConversationRunAdmissionReconciler.class);

  private final ConversationRunStore store;
  private final ConversationRunAdmissionService admission;
  private final ConversationRunAdmissionProperties admissionProperties;

  public ConversationRunAdmissionReconciler(
      ConversationRunStore store,
      ConversationRunAdmissionService admission,
      ConversationRunAdmissionProperties admissionProperties) {
    this.store = store;
    this.admission = admission;
    this.admissionProperties = admissionProperties;
  }

  @EventListener(ApplicationReadyEvent.class)
  public void onReady() {
    reconcileIfNeeded("startup").subscribe();
  }

  /** Reconcile when Redis counters are clearly above configured limits (stale increments). */
  public Mono<Void> reconcileIfDrift(String userId) {
    if (!store.isDbBacked() || !admission.isEnabled()) {
      return Mono.empty();
    }
    String uid = userId != null && !userId.isBlank() ? userId : "dev-user";
    return admission
        .status(uid)
        .flatMap(
            st -> {
              int maxUr = admissionProperties.getMaxUserRunning();
              int maxGr = admissionProperties.getMaxGlobalRunning();
              int maxUq = admissionProperties.getMaxUserQueued();
              boolean drift =
                  st.userRunning() > maxUr * 2L
                      || st.globalRunning() > maxGr * 2L
                      || st.userQueued() > maxUq * 2L;
              if (!drift) {
                return Mono.empty();
              }
              return reconcileIfNeeded("drift userId=" + uid);
            });
  }

  public Mono<Void> reconcileIfNeeded(String reason) {
    if (!store.isDbBacked() || !admission.isEnabled()) {
      return Mono.empty();
    }
    var snap = store.countAdmissionSnapshot();
    Map<String, long[]> perUser = new HashMap<>();
    for (var u : snap.perUser()) {
      String uid = u.userId() != null && !u.userId().isBlank() ? u.userId() : "dev-user";
      perUser.put(uid, new long[] {u.queued(), u.running()});
    }
    log.info(
        "Reconciling admission counters ({}) db globalQueued={} globalRunning={} users={}",
        reason,
        snap.globalQueued(),
        snap.globalRunning(),
        perUser.size());
    // Sync DB-truth counters, then clear any stale per-user Redis counters
    // for users that have NO queued/running runs in the DB.
    return admission
        .syncCounters(snap.globalQueued(), snap.globalRunning(), perUser)
        .then(admission.clearStaleUserCounters(perUser.keySet()));
  }
}

package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.sse.SseEvents;
import java.util.HashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Persists soft checkpoints at phase boundaries so deploy/network kills can resume
 * closer to the last completed phase (in addition to AskUser exact interrupts).
 */
@Component
public class GraphPhaseCheckpointSaver {

    private static final Logger log = LoggerFactory.getLogger(GraphPhaseCheckpointSaver.class);

    private final GraphCheckpointStore checkpointStore;

    public GraphPhaseCheckpointSaver(GraphCheckpointStore checkpointStore) {
        this.checkpointStore = checkpointStore;
    }

    /**
     * @param nextNode graph node to resume from (e.g. preCheck, finalize)
     */
    public void saveAfterPhase(OverAllState state, String phaseId, String nextNode) {
        saveAfterPhase(state, phaseId, nextNode, Map.of());
    }

    /**
     * @param pendingUpdates node updates not yet merged into {@code state} (e.g. journal, trimmed gathered)
     */
    public void saveAfterPhase(
            OverAllState state, String phaseId, String nextNode, Map<String, Object> pendingUpdates) {
        String sessionId = (String) state.value("sessionId").orElse("");
        if (sessionId.isBlank() || phaseId.isBlank() || nextNode.isBlank()) {
            return;
        }
        String token = "phase:" + sessionId + ":" + phaseId;
        Map<String, Object> stateData = new HashMap<>(state.data());
        if (pendingUpdates != null && !pendingUpdates.isEmpty()) {
            stateData.putAll(pendingUpdates);
        }
        stateData.put("lastCheckpointToken", token);
        stateData.put("resumeNextNode", nextNode);
        stateData.put("lastCheckpointKind", "phase_boundary");
        checkpointStore
                .save(token, stateData, nextNode)
                .subscribe(
                        saved -> {
                            if (Boolean.TRUE.equals(saved)) {
                                log.info("Phase checkpoint saved: token={}, nextNode={}", token, nextNode);
                                Map<String, Object> checkpointPayload = new HashMap<>();
                                checkpointPayload.put("continuationToken", token);
                                checkpointPayload.put("nextNode", nextNode);
                                checkpointPayload.put("phaseId", phaseId);
                                checkpointPayload.put("kind", "phase_boundary");
                                Object journal = stateData.get(GraphExecutionJournal.STATE_KEY);
                                if (journal != null) {
                                    checkpointPayload.put(GraphExecutionJournal.STATE_KEY, journal);
                                }
                                GraphSseHelper.emitEvent(
                                        state, SseEvents.GRAPH_CHECKPOINT, checkpointPayload);
                            } else {
                                log.warn("Phase checkpoint save returned false: token={}", token);
                            }
                        },
                        e -> log.warn("Phase checkpoint save failed (non-fatal): {}", e.getMessage()));
    }
}

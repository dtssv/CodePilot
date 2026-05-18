package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.sse.SseEvents;
import java.time.Duration;
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
    private static final Duration SAVE_TIMEOUT = Duration.ofSeconds(5);

    private final GraphCheckpointStore checkpointStore;

    public GraphPhaseCheckpointSaver(GraphCheckpointStore checkpointStore) {
        this.checkpointStore = checkpointStore;
    }

    /**
     * @param nextNode graph node to resume from (e.g. preCheck, finalize)
     */
    public void saveAfterPhase(OverAllState state, String phaseId, String nextNode) {
        String sessionId = (String) state.value("sessionId").orElse("");
        if (sessionId.isBlank() || phaseId.isBlank() || nextNode.isBlank()) {
            return;
        }
        String token = "phase:" + sessionId + ":" + phaseId;
        Map<String, Object> stateData = new HashMap<>(state.data());
        stateData.put("lastCheckpointToken", token);
        stateData.put("resumeNextNode", nextNode);
        stateData.put("lastCheckpointKind", "phase_boundary");
        try {
            Boolean saved =
                    checkpointStore.save(token, stateData, nextNode).block(SAVE_TIMEOUT);
            if (Boolean.TRUE.equals(saved)) {
                log.info("Phase checkpoint saved: token={}, nextNode={}", token, nextNode);
                GraphSseHelper.emitEvent(
                        state,
                        SseEvents.GRAPH_CHECKPOINT,
                        Map.of(
                                "continuationToken", token,
                                "nextNode", nextNode,
                                "phaseId", phaseId,
                                "kind", "phase_boundary"));
            } else {
                log.warn("Phase checkpoint save returned false: token={}", token);
            }
        } catch (Exception e) {
            log.warn("Phase checkpoint save failed (non-fatal): {}", e.getMessage());
        }
    }
}

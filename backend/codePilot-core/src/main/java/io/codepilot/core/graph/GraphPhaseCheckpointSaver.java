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

        // ── Incremental checkpoint optimization ──
        // For super-complex tasks with 100+ phases, storing full state data per phase
        // wastes Redis memory. Instead, store only the delta (changes from last checkpoint)
        // when the state is large.
        Map<String, Object> checkpointData;
        if (stateData.size() > 50) {
            // State is large — store essential keys only for resume capability
            checkpointData = extractEssentialCheckpointData(stateData, phaseId, nextNode, token);
        } else {
            checkpointData = stateData;
        }

        checkpointStore
                .save(token, checkpointData, nextNode)
                .subscribe(
                        saved -> {
                            if (Boolean.TRUE.equals(saved)) {
                                log.info("Phase checkpoint saved: token={}, nextNode={}, keys={}", token, nextNode,
                                        checkpointData.size());
                                Map<String, Object> checkpointPayload = new HashMap<>();
                                checkpointPayload.put("continuationToken", token);
                                checkpointPayload.put("nextNode", nextNode);
                                checkpointPayload.put("phaseId", phaseId);
                                checkpointPayload.put("kind", "phase_boundary");
                                Object journal = checkpointData.get(GraphExecutionJournal.STATE_KEY);
                                if (journal != null) {
                                    checkpointPayload.put(GraphExecutionJournal.STATE_KEY, journal);
                                }
                                Object facts = checkpointData.get(SessionExecutionFacts.STATE_KEY);
                                if (facts != null) {
                                    checkpointPayload.put(SessionExecutionFacts.STATE_KEY, facts);
                                }
                                Object nextTurn = checkpointData.get("summaryForNextTurn");
                                if (nextTurn != null) {
                                    checkpointPayload.put("summaryForNextTurn", nextTurn);
                                }
                                GraphSseHelper.emitLiveOnly(
                                        sessionId, SseEvents.GRAPH_CHECKPOINT, checkpointPayload);
                            } else {
                                log.warn("Phase checkpoint save returned false: token={}", token);
                            }
                        },
                        e -> log.warn("Phase checkpoint save failed (non-fatal): {}", e.getMessage()));
    }

    /**
     * Extract only the essential keys needed for resume capability from a large state.
     * This reduces Redis memory usage for super-complex tasks with 100+ phases.
     *
     * <p>Strategy: exclude known-large/volatile keys that are not needed for resume,
     * rather than whitelisting (which breaks when new keys are added).
     */
    private Map<String, Object> extractEssentialCheckpointData(
            Map<String, Object> fullState, String phaseId, String nextNode, String token) {
        Map<String, Object> essential = new HashMap<>(fullState);

        // Remove keys that are NOT needed for resume — these are either
        // re-computed on resume (memoryLoad node) or are too large to justify
        // storing per-phase (activeMemories, instantMemories, etc. are rebuilt
        // from project memory store on each run).
        String[] excludedKeys = {
                // Re-computed by MemoryLoadAction on each graph run
                "activeMemories", "instantMemories", "shortTermMemories",
                "projectMemories", "globalMemories", "memoryAnomalies",
                "memoryCandidates", "memoryNeedsCompact",
                // Re-computed by GenerateAction from current context
                "pendingPatches", "accumulatedPatches",
                // Re-computed by ApplyPatchAction
                "patchResult", "patchResults", "patchErrors",
                "appliedCount", "failedCount", "shadowValidationErrors",
                "appliedPatches", "phaseOriginalCode",
                // Re-computed by VerifyAction
                "verifyReport", "verifyReportRaw", "clientDiagnostics",
                "testResults", "lintResults",
                // Re-computed by RepairAction
                "repairContext", "repairToolCalls", "repairRetryToolCalls",
                // Per-phase state reset on each phase boundary
                "generateResult", "phaseHasAnalysisOutput",
                "phaseToolsHadFailure", "phaseCommitBlocked",
                "approachEscalationDone", "approachRepeatBlocked",
                "toolApproachExhausted", "directToolRound",
        };

        for (String key : excludedKeys) {
            essential.remove(key);
        }

        // Metadata
        essential.put("lastCheckpointToken", token);
        essential.put("resumeNextNode", nextNode);
        essential.put("lastCheckpointKind", "phase_boundary");
        essential.put("checkpointPhaseId", phaseId);

        log.debug("Phase checkpoint compressed: {} keys → {} keys (excluded volatile/re-computed)",
                fullState.size(), essential.size());

        return essential;
    }
}

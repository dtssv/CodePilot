package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import java.util.Map;

/** Per-phase loop limits for generate / repair / failure retries (from state or defaults). */
public final class GraphLoopBudget {

    private static final int FALLBACK_MAX_GENERATE_PASSES = 5;
    private static final int FALLBACK_MAX_FAILURE_ATTEMPTS = 4;
    private static final int FALLBACK_MAX_REPAIR_ATTEMPTS = 2;

    private GraphLoopBudget() {}

    public static int maxGeneratePasses(OverAllState state) {
        return positiveInt(state, "maxGeneratePassesPerPhase", FALLBACK_MAX_GENERATE_PASSES);
    }

    public static int maxFailureAttempts(OverAllState state) {
        return positiveInt(state, "maxPhaseFailureAttempts", FALLBACK_MAX_FAILURE_ATTEMPTS);
    }

    public static int maxRepairAttempts(OverAllState state) {
        int fromState = positiveInt(state, "maxRepairAttemptsPerPhase", 0);
        if (fromState > 0) {
            return fromState;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> repairPolicy =
                (Map<String, Object>) state.value("graphRepairPolicy").orElse(null);
        if (repairPolicy != null && repairPolicy.get("maxAttempts") instanceof Number n) {
            int policy = n.intValue();
            if (policy > 0) {
                return policy;
            }
        }
        return FALLBACK_MAX_REPAIR_ATTEMPTS;
    }

    public static boolean exceedsMaxGeneratePasses(OverAllState state, int passes) {
        return passes > maxGeneratePasses(state);
    }

    /** Failure retries at or above this should escalate to askUser (stuck step). */
    public static int stuckEscalationThreshold(OverAllState state) {
        return Math.max(2, maxFailureAttempts(state) - 1);
    }

    private static int positiveInt(OverAllState state, String key, int fallback) {
        Object val = state.value(key).orElse(null);
        if (val instanceof Number n) {
            int v = n.intValue();
            if (v > 0) {
                return v;
            }
        }
        return fallback;
    }
}

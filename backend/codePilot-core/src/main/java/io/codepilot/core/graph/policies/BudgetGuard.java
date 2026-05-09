package io.codepilot.core.graph.policies;

import io.codepilot.core.graph.GraphState;
import org.springframework.stereotype.Component;

/**
 * Enforces budget limits per phase and per run.
 * When any budget is exceeded, the orchestrator should move to "askUser".
 */
@Component
public class BudgetGuard {

    private static final int DEFAULT_MAX_ATTEMPTS = 3;
    private static final int DEFAULT_MAX_GATHER_LOOPS = 3;
    private static final int DEFAULT_MAX_TOTAL_GATHER = 10;

    /** Returns true if the current state is within budget. */
    public boolean allow(GraphState state) {
        return state.currentAttempts() < DEFAULT_MAX_ATTEMPTS
                && state.getGatherLoopCount() <= DEFAULT_MAX_TOTAL_GATHER;
    }

    /** Returns the kind of budget that was violated. */
    public String violatedKind(GraphState state) {
        if (state.currentAttempts() >= DEFAULT_MAX_ATTEMPTS) return "attempts";
        if (state.getGatherLoopCount() > DEFAULT_MAX_TOTAL_GATHER) return "gatherLoop";
        return "unknown";
    }

    /** Current value of the violated budget dimension. */
    public int currentValue(GraphState state) {
        if (state.currentAttempts() >= DEFAULT_MAX_ATTEMPTS) return state.currentAttempts();
        if (state.getGatherLoopCount() > DEFAULT_MAX_TOTAL_GATHER) return state.getGatherLoopCount();
        return 0;
    }

    /** Limit for the violated budget dimension. */
    public int limit(GraphState state) {
        if (state.currentAttempts() >= DEFAULT_MAX_ATTEMPTS) return DEFAULT_MAX_ATTEMPTS;
        if (state.getGatherLoopCount() > DEFAULT_MAX_TOTAL_GATHER) return DEFAULT_MAX_TOTAL_GATHER;
        return 0;
    }

    /** Check if gather loops within current phase are exhausted. */
    public boolean gatherLoopExhausted(GraphState state, int phaseGatherCount) {
        return phaseGatherCount >= DEFAULT_MAX_GATHER_LOOPS;
    }
}
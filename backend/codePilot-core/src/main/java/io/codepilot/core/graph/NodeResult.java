package io.codepilot.core.graph;

/**
 * Result of a {@link GraphNode#execute} invocation.
 *
 * @param nextNode suggested next node (may be overridden by decision)
 * @param reason   human-readable reason for the transition
 * @param decision the edge decision that drives the orchestrator
 */
public record NodeResult(
        String nextNode,
        String reason,
        EdgeDecision decision
) {}
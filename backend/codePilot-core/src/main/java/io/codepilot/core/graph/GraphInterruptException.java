package io.codepilot.core.graph;

/**
 * Thrown by graph nodes (e.g., AskUserAction) to interrupt the synchronous
 * graph execution loop. The StateGraph framework's {@code invoke()} method
 * runs all nodes sequentially until reaching END — there is no native
 * "suspend" mechanism.
 *
 * <p>By throwing this exception, a node signals that the graph should be
 * suspended (not failed). The {@link GraphEngineService} catches this
 * exception in its {@code run()}/{@code resume()} methods and gracefully
 * closes the SSE stream (the DONE event has already been emitted by the
 * node before throwing).
 *
 * <p>The graph's state snapshot is persisted to Redis (via
 * {@link GraphCheckpointStore}) before this exception is thrown, so that
 * a subsequent resume request can reload the state and continue from the
 * interrupt point.
 *
 * <p>This is <strong>not</strong> an error — it is a controlled interrupt
 * for user interaction or async tool execution.
 */
public class GraphInterruptException extends RuntimeException {

    private final String continuationToken;
    private final String reason;

    public GraphInterruptException(String continuationToken, String reason) {
        super("Graph interrupted: reason=" + reason + ", token=" + continuationToken);
        this.continuationToken = continuationToken;
        this.reason = reason;
    }

    public String getContinuationToken() {
        return continuationToken;
    }

    public String getReason() {
        return reason;
    }
}
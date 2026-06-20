package io.codepilot.core.sse;

/**
 * Canonical SSE event names emitted on {@code /v1/conversation/run}.
 *
 * <p>Simplified from the old event model. The new agent loop emits a clean set of events that map
 * directly to the {@link io.codepilot.core.session.StreamEvent} types.
 */
public final class SseEvents {
  // ── Core streaming events ──
  /** Streaming text delta from the model. */
  public static final String TEXT = "text";

  /** Thinking/reasoning content delta. */
  public static final String THINKING = "thinking";

  /** Tool call started. */
  public static final String TOOL_CALL_START = "tool_call_start";

  /** Tool call completed with result. */
  public static final String TOOL_CALL_END = "tool_call_end";

  // ── Lifecycle events ──
  /** Run started. */
  public static final String RUN_STARTED = "run_started";

  /** Run reclaimed after interrupt. */
  public static final String RUN_RECLAIMED = "run_reclaimed";

  /** Session checkpoint saved. */
  public static final String CHECKPOINT = "checkpoint";

  /** Context compaction happened. */
  public static final String COMPACTED = "compacted";

  /** Error occurred. */
  public static final String ERROR = "error";

  /** Session completed. */
  public static final String DONE = "done";

  // ── Legacy compatibility aliases ──
  /** Alias: maps old DELTA event to new TEXT. */
  public static final String DELTA = "text";

  /** Alias: maps old TOOL_CALL to new TOOL_CALL_START. */
  public static final String TOOL_CALL = "tool_call_start";

  /** Alias: maps old TOOL_RESULT_ACK to new TOOL_CALL_END. */
  public static final String TOOL_RESULT_ACK = "tool_call_end";

  private SseEvents() {}
}

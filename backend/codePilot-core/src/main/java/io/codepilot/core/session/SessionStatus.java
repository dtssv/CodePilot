package io.codepilot.core.session;

/**
 * Status of a session lifecycle.
 *
 * <p>A session starts in {@link #IDLE}, transitions to {@link #RUNNING} when the agent loop is
 * active, and ends in one of the terminal states.
 */
public enum SessionStatus {
  /** No active execution. */
  IDLE,
  /** Agent loop is currently running. */
  RUNNING,
  /** Agent loop completed successfully. */
  COMPLETED,
  /** Agent loop terminated due to an error. */
  ERROR,
  /** User cancelled the session. */
  CANCELLED,
  /** Agent loop is paused waiting for user input. */
  AWAITING_INPUT,
  /** Context was compacted; session can be resumed. */
  COMPACTED
}

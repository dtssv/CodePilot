package io.codepilot.core.run;

public final class ConversationRunStatus {
  public static final String QUEUED = "queued";
  public static final String RUNNING = "running";
  public static final String AWAITING_INPUT = "awaiting_input";
  public static final String INTERRUPTED = "interrupted";
  public static final String COMPLETED = "completed";
  public static final String FAILED = "failed";
  public static final String CANCELLED = "cancelled";

  private ConversationRunStatus() {}
}

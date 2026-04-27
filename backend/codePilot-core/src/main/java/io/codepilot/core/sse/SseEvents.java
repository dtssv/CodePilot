package io.codepilot.core.sse;

/** Canonical SSE event names emitted on {@code /v1/conversation/run}. */
public final class SseEvents {
  public static final String DIGEST = "digest";
  public static final String TASK_LEDGER = "task_ledger";
  public static final String PLAN = "plan";
  public static final String PLAN_DELTA = "plan_delta";
  public static final String TOOL_CALL = "tool_call";
  public static final String TOOL_RESULT_ACK = "tool_result_ack";
  public static final String SELF_CHECK = "self_check";
  public static final String NEEDS_INPUT = "needs_input";
  public static final String RISK_NOTICE = "risk_notice";
  public static final String SKILLS_ACTIVATED = "skills_activated";
  public static final String DELTA = "delta";
  public static final String PATCH = "patch";
  public static final String USAGE = "usage";
  public static final String ERROR = "error";
  public static final String DONE = "done";

  private SseEvents() {}
}
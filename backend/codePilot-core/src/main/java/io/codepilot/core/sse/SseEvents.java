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

  // ── Graph engine events ──
  public static final String GRAPH_PLAN = "graph_plan";
  public static final String GRAPH_TRANSITION = "graph_transition";
  public static final String GRAPH_INFO_REQUEST = "graph_info_request";
  public static final String GRAPH_INFO_RESULT = "graph_info_result";
  public static final String GRAPH_VERIFY = "graph_verify";
  public static final String GRAPH_REPAIR_PLAN = "graph_repair_plan";
  public static final String GRAPH_PHASE_DONE = "graph_phase_done";
  public static final String GRAPH_BUDGET_ALERT = "graph_budget_alert";

  // ── Dual-layer plan events ──
  public static final String USER_PLAN = "user_plan";
  public static final String USER_PLAN_PROGRESS = "user_plan_progress";

  private SseEvents() {}
}
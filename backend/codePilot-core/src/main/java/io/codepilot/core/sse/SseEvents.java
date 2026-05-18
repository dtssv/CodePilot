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

  /** Durable run id (P2b queue); first event on queued agent runs. */
  public static final String RUN_STARTED = "run_started";
  /** Emitted when a run is reclaimed on another pod after deploy interrupt. */
  public static final String RUN_RECLAIMED = "run_reclaimed";

  // ── Graph engine events ──
  public static final String GRAPH_PLAN = "graph_plan";
  public static final String GRAPH_TRANSITION = "graph_transition";
  public static final String GRAPH_INFO_REQUEST = "graph_info_request";
  public static final String GRAPH_INFO_RESULT = "graph_info_result";
  public static final String GRAPH_VERIFY = "graph_verify";
  public static final String GRAPH_REPAIR_PLAN = "graph_repair_plan";
  public static final String GRAPH_PHASE_DONE = "graph_phase_done";
  /** Phase-boundary soft checkpoint (Redis + plugin local token). */
  public static final String GRAPH_CHECKPOINT = "graph_checkpoint";
  public static final String GRAPH_BUDGET_ALERT = "graph_budget_alert";

  // ── Dual-layer plan events ──
  public static final String USER_PLAN = "user_plan";
  public static final String USER_PLAN_PROGRESS = "user_plan_progress";

  // ── Interactive Agent events (semantic layer over tool_call) ──
  /** Agent declares its intent/thought before acting (e.g., "Let me check the project structure first"). */
  public static final String AGENT_THINKING = "agent_thinking";
  /** Agent declares a file-reading action with human-readable result (e.g., "This is a Java Maven project"). */
  public static final String AGENT_READING = "agent_reading";
  /** Agent declares a file-writing action with preview (e.g., "Creating TrapRainWater3D.java +101 lines"). */
  public static final String AGENT_WRITING = "agent_writing";
  /** Agent declares a command execution (e.g., "Verifying compilation and running tests"). */
  public static final String AGENT_RUNNING = "agent_running";

  private SseEvents() {}
}
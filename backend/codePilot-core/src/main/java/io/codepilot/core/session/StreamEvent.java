package io.codepilot.core.session;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

/** Streaming event types emitted by the agent loop. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record StreamEvent(Type type, Object payload) {

  public enum Type {
    @JsonProperty("text")
    TEXT,
    @JsonProperty("thinking")
    THINKING,
    @JsonProperty("tool_call_start")
    TOOL_CALL_START,
    @JsonProperty("tool_call_end")
    TOOL_CALL_END,
    @JsonProperty("ask_permission")
    ASK_PERMISSION,
    @JsonProperty("permission_result")
    PERMISSION_RESULT,
    @JsonProperty("checkpoint")
    CHECKPOINT,
    @JsonProperty("checkpoint_writer")
    CHECKPOINT_WRITER,
    @JsonProperty("compacted")
    COMPACTED,
    @JsonProperty("goal_evaluation")
    GOAL_EVALUATION,
    @JsonProperty("error")
    ERROR,
    @JsonProperty("done")
    DONE,
    @JsonProperty("agent_switch")
    AGENT_SWITCH,
    @JsonProperty("task_update")
    TASK_UPDATE,
    @JsonProperty("memory_update")
    MEMORY_UPDATE,
    @JsonProperty("skill_invoked")
    SKILL_INVOKED,
    @JsonProperty("subagent_spawn")
    SUBAGENT_SPAWN,
    @JsonProperty("subagent_progress")
    SUBAGENT_PROGRESS,
    @JsonProperty("subagent_complete")
    SUBAGENT_COMPLETE,
    @JsonProperty("subagent_failed")
    SUBAGENT_FAILED,
    @JsonProperty("fork_created")
    FORK_CREATED
  }

  // ── Payload types ──

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record TextPayload(String content) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record ThinkingPayload(String content) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record ToolCallStartPayload(String callId, String toolName, String args) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record ToolCallEndPayload(
      String callId, String toolName, boolean success, String result) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record AskPermissionPayload(String callId, String toolName, String args, String reason) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record PermissionResultPayload(String callId, boolean approved) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record CheckpointPayload(String checkpointToken, int turnCount, int estimatedTokens) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record CheckpointWriterPayload(int turnCount, double contextUtilization, String summary) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record CompactedPayload(int messagesBefore, int messagesAfter, int tokensSaved) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record GoalEvaluationPayload(
      boolean satisfied, double confidence, String reason, String remainingWork) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record ErrorPayload(String message, String code) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record DonePayload(
      @JsonProperty("reason") SessionState.TerminalReason reason,
      int totalTurns,
      int totalInputTokens,
      int totalOutputTokens,
      double totalCost,
      String summary) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record AgentSwitchPayload(String fromAgent, String toAgent) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record TaskUpdatePayload(String taskId, String taskTitle, String status) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record MemoryUpdatePayload(String action, String details) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record SkillInvokedPayload(String skillName, String description) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record SubagentSpawnPayload(String taskId, String agentName, String description) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record SubagentProgressPayload(String taskId, String status, String progress) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record SubagentCompletePayload(String taskId, String result) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record SubagentFailedPayload(String taskId, String error) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record ForkCreatedPayload(String newSessionId, String parentSessionId) {}

  // ── Factory methods ──

  public static StreamEvent text(String content) {
    return new StreamEvent(Type.TEXT, new TextPayload(content));
  }

  public static StreamEvent thinking(String content) {
    return new StreamEvent(Type.THINKING, new ThinkingPayload(content));
  }

  public static StreamEvent toolCallStart(String callId, String toolName, String args) {
    return new StreamEvent(Type.TOOL_CALL_START, new ToolCallStartPayload(callId, toolName, args));
  }

  public static StreamEvent toolCallEnd(
      String callId, String toolName, boolean success, String result) {
    return new StreamEvent(
        Type.TOOL_CALL_END, new ToolCallEndPayload(callId, toolName, success, result));
  }

  public static StreamEvent askPermission(
      String callId, String toolName, String args, String reason) {
    return new StreamEvent(
        Type.ASK_PERMISSION, new AskPermissionPayload(callId, toolName, args, reason));
  }

  public static StreamEvent permissionResult(String callId, boolean approved) {
    return new StreamEvent(Type.PERMISSION_RESULT, new PermissionResultPayload(callId, approved));
  }

  public static StreamEvent checkpoint(String token, int turnCount, int estimatedTokens) {
    return new StreamEvent(
        Type.CHECKPOINT, new CheckpointPayload(token, turnCount, estimatedTokens));
  }

  public static StreamEvent checkpointWriter(
      int turnCount, double contextUtilization, String summary) {
    return new StreamEvent(
        Type.CHECKPOINT_WRITER,
        new CheckpointWriterPayload(turnCount, contextUtilization, summary));
  }

  public static StreamEvent compacted(int before, int after, int saved) {
    return new StreamEvent(Type.COMPACTED, new CompactedPayload(before, after, saved));
  }

  public static StreamEvent goalEvaluation(
      boolean satisfied, double confidence, String reason, String remainingWork) {
    return new StreamEvent(
        Type.GOAL_EVALUATION,
        new GoalEvaluationPayload(satisfied, confidence, reason, remainingWork));
  }

  public static StreamEvent error(String message, String code) {
    return new StreamEvent(Type.ERROR, new ErrorPayload(message, code));
  }

  public static StreamEvent done(
      SessionState.TerminalReason reason,
      int totalTurns,
      int totalInputTokens,
      int totalOutputTokens,
      double totalCost,
      String summary) {
    return new StreamEvent(
        Type.DONE,
        new DonePayload(
            reason, totalTurns, totalInputTokens, totalOutputTokens, totalCost, summary));
  }

  public static StreamEvent agentSwitch(String fromAgent, String toAgent) {
    return new StreamEvent(Type.AGENT_SWITCH, new AgentSwitchPayload(fromAgent, toAgent));
  }

  public static StreamEvent taskUpdate(String taskId, String taskTitle, String status) {
    return new StreamEvent(Type.TASK_UPDATE, new TaskUpdatePayload(taskId, taskTitle, status));
  }

  public static StreamEvent memoryUpdate(String action, String details) {
    return new StreamEvent(Type.MEMORY_UPDATE, new MemoryUpdatePayload(action, details));
  }

  public static StreamEvent skillInvoked(String skillName, String description) {
    return new StreamEvent(Type.SKILL_INVOKED, new SkillInvokedPayload(skillName, description));
  }

  public static StreamEvent subagentSpawn(String taskId, String agentName, String description) {
    return new StreamEvent(
        Type.SUBAGENT_SPAWN, new SubagentSpawnPayload(taskId, agentName, description));
  }

  public static StreamEvent subagentProgress(String taskId, String status, String progress) {
    return new StreamEvent(
        Type.SUBAGENT_PROGRESS, new SubagentProgressPayload(taskId, status, progress));
  }

  public static StreamEvent subagentComplete(String taskId, String result) {
    return new StreamEvent(Type.SUBAGENT_COMPLETE, new SubagentCompletePayload(taskId, result));
  }

  public static StreamEvent subagentFailed(String taskId, String error) {
    return new StreamEvent(Type.SUBAGENT_FAILED, new SubagentFailedPayload(taskId, error));
  }

  public static StreamEvent forkCreated(String newSessionId, String parentSessionId) {
    return new StreamEvent(
        Type.FORK_CREATED, new ForkCreatedPayload(newSessionId, parentSessionId));
  }
}

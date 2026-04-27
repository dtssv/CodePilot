package io.codepilot.common.conversation;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import java.util.List;
import java.util.Map;

/**
 * Sealed hierarchy of SSE events emitted by {@code /v1/conversation/run}.
 *
 * <p>Each event maps to one SSE {@code event:} name; the {@code data:} payload is the JSON
 * serialization of the event record.
 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.EXISTING_PROPERTY, property = "type")
@JsonSubTypes({
  @JsonSubTypes.Type(value = AgentEvent.DeltaEvent.class, name = "delta"),
  @JsonSubTypes.Type(value = AgentEvent.PlanEvent.class, name = "plan"),
  @JsonSubTypes.Type(value = AgentEvent.PlanDeltaEvent.class, name = "plan_delta"),
  @JsonSubTypes.Type(value = AgentEvent.ToolCallEvent.class, name = "tool_call"),
  @JsonSubTypes.Type(value = AgentEvent.ToolResultAckEvent.class, name = "tool_result_ack"),
  @JsonSubTypes.Type(value = AgentEvent.SelfCheckEvent.class, name = "self_check"),
  @JsonSubTypes.Type(value = AgentEvent.NeedsInputEvent.class, name = "needs_input"),
  @JsonSubTypes.Type(value = AgentEvent.RiskNoticeEvent.class, name = "risk_notice"),
  @JsonSubTypes.Type(value = AgentEvent.DigestEvent.class, name = "digest"),
  @JsonSubTypes.Type(value = AgentEvent.TaskLedgerEvent.class, name = "task_ledger"),
  @JsonSubTypes.Type(value = AgentEvent.SkillsActivatedEvent.class, name = "skills_activated"),
  @JsonSubTypes.Type(value = AgentEvent.PatchEvent.class, name = "patch"),
  @JsonSubTypes.Type(value = AgentEvent.UsageEvent.class, name = "usage"),
  @JsonSubTypes.Type(value = AgentEvent.ErrorEvent.class, name = "error"),
  @JsonSubTypes.Type(value = AgentEvent.DoneEvent.class, name = "done"),
})
public sealed interface AgentEvent {

  /** The SSE event name / discriminating property. */
  String type();

  // ---- Chat + Agent shared ----

  @JsonInclude(JsonInclude.Include.NON_NULL)
  record DeltaEvent(String text) implements AgentEvent {
    @Override
    public String type() {
      return "delta";
    }
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  record UsageEvent(long promptTokens, long completionTokens) implements AgentEvent {
    @Override
    public String type() {
      return "usage";
    }
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  record ErrorEvent(int code, String message, String traceId) implements AgentEvent {
    @Override
    public String type() {
      return "error";
    }
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  record DoneEvent(
      String reason, String continuationToken, String summaryForNextTurn, Boolean subtaskDone)
      implements AgentEvent {
    @Override
    public String type() {
      return "done";
    }
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  record DigestEvent(
      int boundarySeq,
      String goal,
      List<String> decisions,
      List<String> openQuestions,
      List<DigestEvent.KeyFile> keyFiles,
      List<DigestEvent.CompletedStep> completedSteps,
      List<String> pendingHints)
      implements AgentEvent {
    @Override
    public String type() {
      return "digest";
    }

    public record KeyFile(String path, String why) {}

    public record CompletedStep(String id, String summary) {}
  }

  // ---- Agent-only ----

  @JsonInclude(JsonInclude.Include.NON_NULL)
  record PlanEvent(Object plan) implements AgentEvent {
    @Override
    public String type() {
      return "plan";
    }
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  record PlanDeltaEvent(Object planDelta) implements AgentEvent {
    @Override
    public String type() {
      return "plan_delta";
    }
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  record ToolCallEvent(
      String id, String name, Map<String, Object> args, String riskLevel, String why)
      implements AgentEvent {
    @Override
    public String type() {
      return "tool_call";
    }
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  record ToolResultAckEvent(String toolCallId, String status) implements AgentEvent {
    @Override
    public String type() {
      return "tool_result_ack";
    }
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  record SelfCheckEvent(
      String toolCallId, boolean ok, List<Check> checks, String nextAction)
      implements AgentEvent {
    @Override
    public String type() {
      return "self_check";
    }

    public record Check(String name, boolean passed, String detail) {}
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  record NeedsInputEvent(
      String title,
      String reason,
      boolean blocking,
      int maxAnswers,
      boolean freeformAllowed,
      List<Question> questions,
      List<String> notesForUser)
      implements AgentEvent {
    @Override
    public String type() {
      return "needs_input";
    }

    public record Question(
        String id,
        int index,
        String prompt,
        String why,
        String kind,
        boolean required,
        String defaultOptionId,
        List<Option> options,
        String placeholder) {}

    public record Option(
        String id, String label, String impact, List<String> pros, List<String> cons) {}
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  record RiskNoticeEvent(
      String toolCallId, String kind, String preview, List<Mitigation> mitigations)
      implements AgentEvent {
    @Override
    public String type() {
      return "risk_notice";
    }

    public record Mitigation(String label, String description) {}
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  record TaskLedgerEvent(
      String goal, List<Subtask> subtasks, String cursor, List<String> notes, List<String> blockers)
      implements AgentEvent {
    @Override
    public String type() {
      return "task_ledger";
    }

    public record Subtask(
        String id, String title, String status, String why) {}
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  record SkillsActivatedEvent(List<SkillItem> items, List<String> droppedDueToBudget)
      implements AgentEvent {
    @Override
    public String type() {
      return "skills_activated";
    }

    public record SkillItem(String id, String version, int tokens, int priority, String source) {}
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  record PatchEvent(List<Patch> patches) implements AgentEvent {
    @Override
    public String type() {
      return "patch";
    }

    public record Patch(String path, String op, ConversationRequest.Range range, String newContent) {}
  }
}
package io.codepilot.core.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.List;
import java.util.Map;

/** Mirrors the public request schema in docs/05-接口文档.md §3.1.2. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ConversationRunRequest(
    @NotBlank String sessionId,
    @NotNull ConversationMode mode,
    String modelId,
    @NotBlank String input,
    Intent intent,
    String continuationToken,
    List<Answer> answers,
    TaskLedger taskLedger,
    LastPlanDigest lastPlanDigest,
    String lastAssistantTurnSummary,
    Digest sessionDigest,
    Contexts contexts,
    List<String> tools,
    List<CompletedToolCall> completedToolCallsTail,
    Integer earlierToolCallsCount,
    String projectRootHash,
    List<UserSkill> userSkills,
    List<UserMcp> userMcps,
    List<PlanEdit> userPlanEdits,
    Options options,
    Policy policy,
    Skills skills) {

  public enum Intent {
    @JsonProperty("new") NEW,
    @JsonProperty("continue") CONTINUE,
    @JsonProperty("answer") ANSWER,
    @JsonProperty("cancel") CANCEL
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Answer(String questionId, String optionId, String freeform, Double confidence) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record LastPlanDigest(
      String goal, List<Plan.Step> steps, Integer totalSteps, List<String> completedStepIds) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Contexts(
      List<PinnedItem> pinned, List<RecentMessage> recent, List<Ref> refs) {

    public record PinnedItem(String kind, String path, String range, String sha1, String reason) {}

    public record RecentMessage(String role, String content, String summary, Long seq) {}

    public record Ref(String path, Boolean outlineOnly, String range, String sha1) {}
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record CompletedToolCall(
      String toolCallId, Boolean ok, String name, String argsHash, String summary) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record UserSkill(
      String id, String version, String source, String scope, String projectRootHash,
      String sha256, String yaml) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record UserMcp(
      String id,
      String version,
      String source,
      String scope,
      String projectRootHash,
      Map<String, Object> permissions) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record PlanEdit(String op, String stepId, Plan.Step step, String reason) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Options(Double temperature, Integer maxTokens, String locale) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Policy(
      Integer maxSteps,
      Boolean autoApply,
      String osHint,
      String requestCompact,
      Boolean replanHint,
      Boolean selfCheck,
      List<String> stopOn,
      String askPolicy,
      Integer contextBudgetTokens,
      Integer keepRecentMessages) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Skills(List<String> requested, List<String> disabled) {}
}
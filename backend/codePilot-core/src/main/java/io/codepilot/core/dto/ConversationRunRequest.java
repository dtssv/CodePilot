package io.codepilot.core.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import io.codepilot.core.model.ModelSource;
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
    /** Indicates whether modelId refers to a system model group or a user custom model. */
    ModelSource modelSource,
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
    List<Map<String, Object>> mcpTools,
    List<PlanEdit> userPlanEdits,
    Options options,
    Policy policy,
    Skills skills,
    // ★ 新增：来自 .codepilot/rules/ 的项目规则文本列表
    List<String> projectRules,
    // ★ 新增：多模态图片输入
    List<Image> images,
    // ★ 新增：Graph状态快照（插件端上传，用于断点恢复）
    Map<String, Object> graphState,
    // ★ 新增：项目元信息（语言、根目录文件列表），由插件端注入，供 LLM 了解项目上下文
    String projectMeta) {

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
      Integer keepRecentMessages,
      // ── Graph engine fields ──
      String engine,              // "graph" | "legacy" (default: legacy)
      String graphTemplate,       // "default" | "refactor" | "migrate" | "bugfix"
      GraphVerifyPolicy verify,
      GraphRepairPolicy repair,
      GraphGatherPolicy gather,
      Boolean autoContinue,
      Boolean askOnUncertain) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record GraphVerifyPolicy(
      Boolean compile, Boolean test, Boolean lint,
      List<CustomCommand> customCommands) {
    public record CustomCommand(String name, String cmd, Integer timeoutMs) {}
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record GraphRepairPolicy(Integer maxAttempts, List<String> escalateOn) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record GraphGatherPolicy(Integer gatherLoopMax, Integer gatherBudgetTokens) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Skills(List<String> requested, List<String> disabled) {}

  /** Multi-modal image input. */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Image(String data, String mimeType, String description) {}
}
package io.codepilot.core.session;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import io.codepilot.core.model.ModelSource;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
import java.util.Map;

/**
 * Run request from the plugin. Session start parameters.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record RunRequest(
    String sessionId,
    @NotBlank String input,
    String modelId,
    ModelSource modelSource,
    Intent intent,
    String continuationToken,
    String goalCondition,
    List<Answer> answers,
    Contexts contexts,
    List<String> tools,
    List<Map<String, Object>> mcpTools,
    String projectMeta,
    String workspaceRoot,
    String osHint,
    String projectRootHash,
    List<String> projectRules,
    List<Image> images,
    Options options,
    String mode,                              // "build" | "plan" | "compose" | custom agent name
    List<String> skillDirs,                   // plugin-reported skill directories for SKILL.md discovery
    Map<String, Object> permissionOverrides,    // user permission overrides
    String parentSessionId,                     // for subagent tracking
    String modelLanguage,                      // language hint for the LLM
    Boolean maxMode,                            // best-of-N plan sampling toggle
    Integer maxModeSamples                      // number of candidates for max mode (default 3)
    ) {

  /** Effective number of max-mode samples (default 3, min 2). */
  public int maxModeSampleCount() {
    if (maxModeSamples == null || maxModeSamples < 2) return 3;
    return Math.min(maxModeSamples, 8);
  }

  /** Whether best-of-N max mode was requested. */
  public boolean isMaxMode() {
    return Boolean.TRUE.equals(maxMode);
  }

  public enum Intent {
    @JsonProperty("new") NEW,
    @JsonProperty("continue") CONTINUE,
    @JsonProperty("answer") ANSWER,
    @JsonProperty("cancel") CANCEL,
    @JsonProperty("fork") FORK
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Answer(String questionId, String optionId, String freeform, Double confidence) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Contexts(
      List<PinnedItem> pinned, List<RecentMessage> recent, List<Ref> refs) {
    public record PinnedItem(String kind, String path, String range, String sha1, String reason) {}
    public record RecentMessage(String role, String content, String summary, Long seq) {}
    public record Ref(String path, Boolean outlineOnly, String range, String sha1) {}
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Image(String data, String mimeType, String description) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Options(
      Double temperature, Integer maxTurns, Integer maxOutputTokens,
      String thinkingMode, String language) {}

  public Intent intent() { return intent != null ? intent : Intent.NEW; }
}
package io.codepilot.common.conversation;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.List;
import java.util.Map;

/**
 * Unified request for {@code POST /v1/conversation/run} (Chat & Agent share the same endpoint).
 *
 * <p>Mode determines which PromptOrchestrator strategy is used and whether tool calls are allowed.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ConversationRequest(
    @NotBlank String sessionId,
    @NotNull Mode mode,
    @NotBlank String modelId,
    @NotBlank String input,
    String intent,
    List<@Valid ContextItem> contexts,
    List<@Valid Answer> answers,
    Policy policy,
    String continuationToken,
    List<@Valid UserSkill> userSkills,
    String projectRootHash) {

  public ConversationRequest {
    if (intent == null) intent = "new";
    if (contexts == null) contexts = List.of();
    if (answers == null) answers = List.of();
    if (userSkills == null) userSkills = List.of();
  }

  /** Chat = read-only, no tools; Agent = plan-first + tools. */
  public enum Mode {
    chat,
    agent
  }

  public record ContextItem(
      @NotBlank String type,
      String language,
      String path,
      Range range,
      String content,
      String sha1,
      Integer tokensEstimate) {}

  public record Range(int startLine, int endLine) {}

  public record Answer(String questionId, String optionId, String freeform) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Policy(
      Boolean requestCompact,
      Boolean replanHint,
      Boolean selfCheck,
      String askPolicy,
      Integer maxSteps,
      Integer contextBudgetTokens,
      Integer keepRecentMessages) {

    public Policy {
      if (requestCompact == null) requestCompact = false;
      if (replanHint == null) replanHint = false;
      if (selfCheck == null) selfCheck = true;
      if (askPolicy == null) askPolicy = "prefer-ask";
      if (maxSteps == null) maxSteps = 25;
      if (contextBudgetTokens == null) contextBudgetTokens = 100_000;
      if (keepRecentMessages == null) keepRecentMessages = 10;
    }
  }

  /** User-skill carried per-request; never persisted server-side. */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record UserSkill(
      @NotBlank String id,
      @NotBlank String version,
      @NotBlank String source,
      String scope,
      String systemPrompt,
      Map<String, Object> triggers,
      List<String> permissions) {}
}
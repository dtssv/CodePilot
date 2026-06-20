package io.codepilot.core.skill;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/** Server-side Skill model used to drive {@link SkillRouter}. Mirrors docs/04-Prompt模板.md §A. */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonIgnoreProperties(ignoreUnknown = true)
public record SkillManifest(
    String id,
    String version,
    String title,
    String source, // "system" or "user"
    String scope, // "system" / "project" / "global"
    int priority,
    String merge, // append | wrap | override
    Triggers triggers,
    Permissions permissions,
    Audit audit,
    String systemPrompt,
    Category category) {

  /**
   * Coarse category caps used by [SkillRouter] (lang.primary <= 1, lang.aux <= 2, scenario <= 2).
   */
  public enum Category {
    GENERIC,
    LANG_PRIMARY,
    LANG_AUX,
    SCENARIO,
    ACTION
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  @JsonIgnoreProperties(ignoreUnknown = true)
  public record Triggers(List<TriggerGroup> all, List<TriggerGroup> any) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  @JsonIgnoreProperties(ignoreUnknown = true)
  public record TriggerGroup(
      List<String> language,
      List<String> framework,
      List<String> action,
      List<String> fileGlob,
      List<String> keywords) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  @JsonIgnoreProperties(ignoreUnknown = true)
  public record Permissions(List<String> tools, List<String> risk) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  @JsonIgnoreProperties(ignoreUnknown = true)
  public record Audit(Integer tokensEstimate, List<String> tags) {}
}

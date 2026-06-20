package io.codepilot.core.skill;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A skill is a reusable workflow definition loaded from SKILL.md files. 
 * Skill.Info structure.
 *
 * <p>Skills are discovered from:
 *
 * <ul>
 *   <li>Project-local: <code>.codepilot/skills/</code>
 *   <li>Plugin-reported: directories sent via RunRequest
 *   <li>Built-in: bundled with the application
 *   <li>Remote: fetched from URLs (future)
 * </ul>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SkillInfo(
    @JsonProperty("name") String name,
    @JsonProperty("description") String description,
    @JsonProperty("location") String location,
    @JsonProperty("content") String content,
    @JsonProperty("hidden") boolean hidden) {

  /**
   * Parse a SKILL.md file into a SkillInfo. Supports frontmatter with name, description, hidden
   * fields. If no frontmatter, uses filename as name and first line as description.
   */
  public static SkillInfo parse(String content, String location) {
    String name = null;
    String description = null;
    boolean hidden = false;
    String body = content;

    // Parse frontmatter (--- ... ---)
    if (content.startsWith("---")) {
      int end = content.indexOf("---", 3);
      if (end > 0) {
        String frontmatter = content.substring(3, end).trim();
        body = content.substring(end + 3).trim();
        for (String line : frontmatter.split("\n")) {
          line = line.trim();
          if (line.startsWith("name:")) name = line.substring(5).trim();
          else if (line.startsWith("description:")) description = line.substring(12).trim();
          else if (line.startsWith("hidden:"))
            hidden = Boolean.parseBoolean(line.substring(7).trim());
        }
      }
    }

    // Fallback: extract from content
    if (name == null || name.isBlank()) {
      // Use filename without extension as name
      name = location.contains("/") ? location.substring(location.lastIndexOf('/') + 1) : location;
      name = name.replace(".md", "").replace("SKILL", "").trim();
      if (name.isBlank()) name = "unnamed-skill";
    }
    if (description == null || description.isBlank()) {
      // Use first non-empty line as description
      for (String line : body.split("\n")) {
        String trimmed = line.trim();
        if (!trimmed.isEmpty() && !trimmed.startsWith("#")) {
          description = trimmed.length() > 200 ? trimmed.substring(0, 200) + "..." : trimmed;
          break;
        }
      }
      if (description == null) description = "Skill: " + name;
    }

    return new SkillInfo(name, description, location, body, hidden);
  }

  /** Format for injection into the system prompt. */
  public String toPromptSection() {
    StringBuilder sb = new StringBuilder();
    sb.append("## Skill: ").append(name).append("\n\n");
    sb.append(content).append("\n\n");
    return sb.toString();
  }
}

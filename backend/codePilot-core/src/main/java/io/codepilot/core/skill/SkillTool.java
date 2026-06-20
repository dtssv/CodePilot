package io.codepilot.core.skill;

import io.codepilot.core.agent.tool.ToolResult;
import io.codepilot.core.session.tool.ToolDefinition;
import io.codepilot.core.session.tool.ToolExecutor;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: `skill` — invokes a named skill by injecting its content as context. */
@Component
public class SkillTool {

  private final SkillService skillService;

  public SkillTool(SkillService skillService) {
    this.skillService = skillService;
  }

  public ToolDefinition definition() {
    return new ToolDefinition(
        "skill",
        "Invoke a named skill to load its instructions. Skills provide structured workflows.",
        Map.of(
            "type", "object",
            "properties",
                Map.of(
                    "name",
                    Map.of(
                        "type", "string",
                        "description", "Name of the skill to invoke")),
            "required", List.of("name")),
        true, // readOnly
        false // requiresPermission
        );
  }

  public ToolExecutor executor() {
    return call -> {
      @SuppressWarnings("unchecked")
      Map<String, Object> args = call.args();
      String skillName = args != null ? (String) args.get("name") : null;
      if (skillName == null || skillName.isBlank()) {
        return new ToolResult(false, "Missing required parameter: name");
      }

      var skill = skillService.get(skillName);
      if (skill.isEmpty()) {
        List<SkillInfo> available = skillService.available(false);
        StringBuilder sb =
            new StringBuilder("Unknown skill: " + skillName + "\n\nAvailable skills:\n");
        for (SkillInfo s : available) {
          sb.append("- ").append(s.name()).append(": ").append(s.description()).append("\n");
        }
        return new ToolResult(false, sb.toString());
      }

      return new ToolResult(true, skill.get().toPromptSection());
    };
  }
}

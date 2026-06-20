package io.codepilot.core.session.prompt.layer;

import io.codepilot.core.session.prompt.PromptContext;
import io.codepilot.core.session.prompt.PromptLayer;
import java.util.List;
import org.springframework.stereotype.Component;

/**
 * Injects project rules and MCP tool descriptions into the system prompt.
 *
 * <p>Priority: 25 (after tool instructions, before context).
 */
@Component
public class RulesAndMcpLayer implements PromptLayer {
  @Override
  public int priority() {
    return 25;
  }

  @Override
  public String build(PromptContext ctx) {
    var sb = new StringBuilder();
    var session = ctx.session();

    // Project rules
    List<String> rules = session.getProjectRules();
    if (rules != null && !rules.isEmpty()) {
      sb.append("# Project Rules\n\n");
      sb.append("The following rules must be followed when working in this project:\n\n");
      for (String rule : rules) {
        sb.append("- ").append(rule).append("\n");
      }
      sb.append("\n");
    }

    // MCP tools
    var mcpTools = session.getMcpTools();
    if (mcpTools != null && !mcpTools.isEmpty()) {
      sb.append("# MCP Tools\n\n");
      sb.append("The following MCP tools are available and can be called via `mcp_bridge`:\n\n");
      for (var tool : mcpTools) {
        String name = (String) tool.get("name");
        String description = (String) tool.get("description");
        if (name != null) {
          sb.append("- **").append(name).append("**: ");
          sb.append(description != null ? description : "No description").append("\n");
        }
      }
      sb.append("\n");
    }

    return sb.toString();
  }
}

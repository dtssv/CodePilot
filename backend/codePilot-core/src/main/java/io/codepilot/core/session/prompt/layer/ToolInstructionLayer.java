package io.codepilot.core.session.prompt.layer;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.agent.AgentDefinition;
import io.codepilot.core.agent.AgentRegistry;
import io.codepilot.core.permission.PermissionEngine;
import io.codepilot.core.permission.PermissionRule;
import io.codepilot.core.session.prompt.PromptContext;
import io.codepilot.core.session.prompt.PromptLayer;
import io.codepilot.core.session.tool.ToolRegistry;

/**
 * Inject tool definitions and invocation format into the system prompt.
 *
 * <p>Tools are described in the system prompt (not via OpenAI function calling API) so that we
 * retain full control over tool execution without Spring AI's auto-execution mechanism.
 *
 * <p>Only tools the active agent is permitted to use are advertised: a tool is shown when it is in
 * the agent's allowlist (or the agent has no allowlist) and the permission engine does not outright
 * DENY it. This keeps the read-only plan agent from being told about write/shell tools it cannot
 * call.
 *
 * <p>Priority: 20 (after environment, before context).
 */
@org.springframework.stereotype.Component
public class ToolInstructionLayer implements PromptLayer {

  private static final ObjectMapper MAPPER = new ObjectMapper();

  private final ToolRegistry toolRegistry;
  private final AgentRegistry agentRegistry;
  private final PermissionEngine permissionEngine;

  public ToolInstructionLayer(
      ToolRegistry toolRegistry, AgentRegistry agentRegistry, PermissionEngine permissionEngine) {
    this.toolRegistry = toolRegistry;
    this.agentRegistry = agentRegistry;
    this.permissionEngine = permissionEngine;
  }

  @Override
  public int priority() {
    return 20;
  }

  @Override
  public String build(PromptContext ctx) {
    var sb = new StringBuilder();

    sb.append(
        """
        # Available Tools

        You have access to the following tools. Each tool has a name, description,
        parameters (JSON Schema), and metadata flags.

        ## Tool invocation format

        When you need to call a tool, output a JSON block in the following format:

        ```tool_call
        {"name": "<tool_name>", "arguments": {<arg_key>: <arg_value>, ...}}
        ```

        You may call multiple tools by outputting multiple ```tool_call blocks.
        After each tool call, you will receive the result in the next message.

        ## CRITICAL RULES
        - NEVER fabricate, simulate, or guess tool results. You MUST wait for the
          actual tool result to be returned before proceeding. Do NOT output
          ```json blocks that look like tool results.
        - NEVER pretend a tool was executed. If you want to call a tool, use the
          proper tool_call format or native function calling. Do NOT describe what
          the tool would return.
        - Read-only tools (`readOnly: true`) never modify the user's filesystem.
        - Tools marked `requiresPermission: true` need user approval before execution.
        - You may call multiple tools in parallel when the calls are independent.
        - Always use exact parameter names and types as specified in the schema.

        ## Tool schemas

        """);

    AgentDefinition agent = agentRegistry.resolve(ctx.session().getCurrentAgent());
    var override = ctx.session().getPermissionOverride();
    for (var tool : toolRegistry.getDefinitions()) {
      if (!isAdvertised(agent, override, tool.name())) continue;
      sb.append("### ").append(tool.name()).append("\n");
      sb.append("**Description**: ").append(tool.description()).append("\n");
      sb.append("**readOnly**: ").append(tool.readOnly()).append("\n");
      sb.append("**requiresPermission**: ").append(tool.requiresPermission()).append("\n");
      sb.append("**Parameters** (JSON Schema):\n");
      sb.append("```json\n");
      try {
        sb.append(
            MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(tool.parametersSchema()));
      } catch (Exception e) {
        sb.append("{ \"type\": \"object\", \"properties\": {} }");
      }
      sb.append("\n```\n\n");
    }

    // Session-scoped MCP tools — advertised here and dispatched to the plugin as REMOTE.
    java.util.List<java.util.Map<String, Object>> mcpTools = ctx.session().getMcpTools();
    if (mcpTools != null) {
      for (var t : mcpTools) {
        Object nameObj = t.get("name");
        if (nameObj == null) continue;
        String name = nameObj.toString();
        if (name.isBlank()) continue;
        if (permissionEngine.evaluate(agent, override, name, "*") == PermissionRule.Action.DENY)
          continue;
        sb.append("### ").append(name).append(" (MCP)\n");
        sb.append("**Description**: ")
            .append(t.getOrDefault("description", "MCP tool"))
            .append("\n");
        sb.append("**readOnly**: false\n");
        sb.append("**requiresPermission**: true\n");
        Object schema = t.get("inputSchema");
        if (schema == null) schema = t.get("parametersSchema");
        sb.append("**Parameters** (JSON Schema):\n```json\n");
        try {
          sb.append(
              MAPPER
                  .writerWithDefaultPrettyPrinter()
                  .writeValueAsString(
                      schema != null
                          ? schema
                          : java.util.Map.of("type", "object", "properties", java.util.Map.of())));
        } catch (Exception e) {
          sb.append("{ \"type\": \"object\", \"properties\": {} }");
        }
        sb.append("\n```\n\n");
      }
    }

    return sb.toString();
  }

  /** Whether a tool should be advertised to the active agent. */
  private boolean isAdvertised(
      AgentDefinition agent,
      io.codepilot.core.permission.PermissionRuleset override,
      String toolName) {
    if (!permissionEngine.isToolAllowed(agent, toolName)) return false;
    return permissionEngine.evaluate(agent, override, toolName, "*") != PermissionRule.Action.DENY;
  }
}

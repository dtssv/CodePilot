package io.codepilot.core.mcp;

import io.codepilot.core.agent.tool.ToolResult;
import io.codepilot.core.session.tool.ToolDefinition;
import io.codepilot.core.session.tool.ToolExecutor;
import java.util.Map;

/**
 * Dynamic tool definition + executor for MCP tools relayed through the plugin.
 *
 * <p>When the agent calls an MCP tool, the AgentLoop emits a TOOL_CALL_START SSE event. The plugin
 * (which runs the MCP client) receives the event, executes the tool locally, and POSTs the result
 * to /v1/conversation/tool-result.
 *
 * <p>This executor acts as a short-circuit — it returns a "relay" result. The actual result is
 * delivered asynchronously through the permission/response mechanism in AgentLoop.
 */
public class McpToolBridge {

  private final String toolName;
  private final String description;
  private final Map<String, Object> parameterSchema;

  public McpToolBridge(String toolName, String description, Map<String, Object> parameterSchema) {
    this.toolName = toolName;
    this.description = description;
    this.parameterSchema = parameterSchema;
  }

  @SuppressWarnings("unchecked")
  public static McpToolBridge fromMap(Map<String, Object> toolDef) {
    String name = (String) toolDef.getOrDefault("name", "unknown");
    String desc = (String) toolDef.getOrDefault("description", "MCP tool: " + name);
    Map<String, Object> schema =
        (Map<String, Object>)
            toolDef.getOrDefault("inputSchema", Map.of("type", "object", "properties", Map.of()));
    return new McpToolBridge(name, desc, schema);
  }

  public ToolDefinition definition() {
    return new ToolDefinition(toolName, description, parameterSchema, false, true);
  }

  public ToolExecutor executor() {
    return call ->
        new ToolResult(true, "[MCP tool relay: " + toolName + " - awaiting plugin response]");
  }
}

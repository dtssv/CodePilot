package io.codepilot.core.tool;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.common.conversation.AgentEvent.ToolCallEvent;
import io.codepilot.common.conversation.ConversationRequest;
import io.codepilot.common.conversation.ToolResultRequest;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Sinks;

/**
 * Routes tool calls to the appropriate executor based on the tool's {@code executor} field.
 *
 * <p>Per §5 of the backend design doc:
 *
 * <ul>
 *   <li>{@code client} — tool call is sent to the plugin via SSE, plugin executes locally and
 *       posts result back via {@code /v1/conversation/tool-result}
 *   <li>{@code server} — backend executes directly (e.g., RAG search)
 *   <li>{@code mcp} — backend proxies to an MCP server (M4)
 * </ul>
 *
 * <p>For M3, we support:
 *
 * <ul>
 *   <li>Client-side tools: the agent loop emits a {@link ToolCallEvent} and waits for the result
 *   <li>A few basic server-side tools for demo purposes
 * </ul>
 */
@Service
public class ToolRouter {

  private static final ObjectMapper MAPPER = new ObjectMapper();

  /** Pending tool results keyed by (sessionId + toolCallId). Cleared on result arrival. */
  private final Map<String, Sinks.One<ToolResultRequest>> pendingResults =
      new ConcurrentHashMap<>();

  /** Built-in tool definitions with their executor type and JSON Schema. */
  private final List<ToolDef> builtinTools =
      List.of(
          ToolDef.client("fs.read", "Read file content", fileReadSchema()),
          ToolDef.client("fs.list", "List directory contents", fileListSchema()),
          ToolDef.client("fs.replace", "Replace text in a file", fileReplaceSchema()),
          ToolDef.client("fs.search", "Search text in project", fileSearchSchema()),
          ToolDef.client("shell.exec", "Execute a shell command", shellExecSchema()),
          ToolDef.client("plan.show", "Display plan to user", planShowSchema()));

  /** Returns the JSON Schema string for all available tools (for injection into the prompt). */
  public String toolsSchemaJson() {
    try {
      return MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(builtinTools);
    } catch (Exception e) {
      return "[]";
    }
  }

  /**
   * Registers a sink that will be completed when the tool result arrives from the plugin. Called by
   * the agent loop before emitting a ToolCallEvent.
   */
  public Sinks.One<ToolResultRequest> registerPending(String sessionId, String toolCallId) {
    String key = key(sessionId, toolCallId);
    Sinks.One<ToolResultRequest> sink = Sinks.one();
    pendingResults.put(key, sink);
    return sink;
  }

  /**
   * Completes the pending sink with the tool result posted by the plugin. Called by
   * ToolResultController.
   */
  public boolean completeResult(ToolResultRequest result) {
    String key = key(result.sessionId(), result.toolCallId());
    Sinks.One<ToolResultRequest> sink = pendingResults.remove(key);
    if (sink != null) {
      sink.tryEmitValue(result);
      return true;
    }
    return false;
  }

  /** Determines the executor type for a given tool name. */
  public ExecutorType executorFor(String toolName) {
    for (ToolDef def : builtinTools) {
      if (def.name().equals(toolName)) {
        return def.executor();
      }
    }
    // Default to client for unknown tools (agent will send via SSE)
    return ExecutorType.client;
  }

  private String key(String sessionId, String toolCallId) {
    return sessionId + ":" + toolCallId;
  }

  // ---- Schema helpers ----

  private static Map<String, Object> fileReadSchema() {
    return Map.of(
        "type", "object",
        "properties",
            Map.of(
                "path", Map.of("type", "string", "description", "File path"),
                "range",
                    Map.of(
                        "type", "object",
                        "properties",
                            Map.of(
                                "startLine", Map.of("type", "integer"),
                                "endLine", Map.of("type", "integer")))),
        "required", List.of("path"));
  }

  private static Map<String, Object> fileListSchema() {
    return Map.of(
        "type", "object",
        "properties",
            Map.of("path", Map.of("type", "string", "description", "Directory path")),
        "required", List.of("path"));
  }

  private static Map<String, Object> fileReplaceSchema() {
    return Map.of(
        "type", "object",
        "properties",
            Map.of(
                "path", Map.of("type", "string"),
                "search", Map.of("type", "string"),
                "replace", Map.of("type", "string"),
                "regex", Map.of("type", "boolean", "default", false)),
        "required", List.of("path", "search", "replace"));
  }

  private static Map<String, Object> fileSearchSchema() {
    return Map.of(
        "type", "object",
        "properties",
            Map.of(
                "query", Map.of("type", "string"),
                "filePattern", Map.of("type", "string")),
        "required", List.of("query"));
  }

  private static Map<String, Object> shellExecSchema() {
    return Map.of(
        "type", "object",
        "properties",
            Map.of("command", Map.of("type", "string"), "timeout", Map.of("type", "integer", "default", 60)),
        "required", List.of("command"));
  }

  private static Map<String, Object> planShowSchema() {
    return Map.of("type", "object", "properties", Map.of());
  }

  // ---- Inner types ----

  public enum ExecutorType {
    client,
    server,
    mcp
  }

  record ToolDef(String name, String description, ExecutorType executor, Map<String, Object> parameters) {
    static ToolDef client(String name, String desc, Map<String, Object> params) {
      return new ToolDef(name, desc, ExecutorType.client, params);
    }

    static ToolDef server(String name, String desc, Map<String, Object> params) {
      return new ToolDef(name, desc, ExecutorType.server, params);
    }
  }
}
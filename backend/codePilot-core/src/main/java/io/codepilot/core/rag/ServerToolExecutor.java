package io.codepilot.core.rag;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.mcp.McpToolExecutor;
import io.codepilot.core.rag.dto.RagSearchRequest;
import io.codepilot.core.rag.dto.RagSearchResponse;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Executes server-side tools (executor="server") within the AgentLoop. Currently supports:
 *
 * <ul>
 *   <li>{@code rag.search} - semantic search over session-scoped pgvector index
 *   <li>{@code mcp.call} - call an MCP server tool via HTTP/SSE transport
 * </ul>
 */
@Component
public class ServerToolExecutor {

  private static final Logger log = LoggerFactory.getLogger(ServerToolExecutor.class);

  private final RagService ragService;
  private final McpToolExecutor mcpToolExecutor;
  private final ObjectMapper mapper;

  public ServerToolExecutor(
      RagService ragService, McpToolExecutor mcpToolExecutor, ObjectMapper mapper) {
    this.ragService = ragService;
    this.mcpToolExecutor = mcpToolExecutor;
    this.mapper = mapper;
  }

  /** Returns true if the given tool name is a server-side tool. */
  public boolean isServerTool(String toolName) {
    return "rag.search".equals(toolName);
  }

  /**
   * Executes a server-side tool and returns a JSON result string.
   *
   * @param toolName the tool name (e.g. "rag.search", "mcp.call")
   * @param args the arguments as a JSON object node
   * @param sessionId the current session ID
   * @return JSON string of the result
   */
  public String execute(String toolName, JsonNode args, String sessionId) {
    return switch (toolName) {
      case "rag.search" -> executeRagSearch(args, sessionId);
      case "mcp.call" ->
          "{\"ok\":false,\"error\":\"mcp.call must run on the plugin client (gather/tool_call)\"}";
      default -> "{\"error\":\"Unknown server tool: " + toolName + "\"}";
    };
  }

  private String executeRagSearch(JsonNode args, String sessionId) {
    String query = args.has("query") ? args.get("query").asText() : "";
    int topK = args.has("topK") ? args.get("topK").asInt(8) : 8;

    RagSearchRequest req = new RagSearchRequest(UUID.fromString(sessionId), query, topK);
    RagSearchResponse response = ragService.search(req);

    try {
      return mapper.writeValueAsString(response);
    } catch (Exception e) {
      log.error("Failed to serialize rag.search result", e);
      return "{\"error\":\"Serialization failed\"}";
    }
  }

  /**
   * Execute an MCP tool call.
   *
   * <p>Expected args format:
   *
   * <pre>{@code
   * {
   *   "serverId": "weather",
   *   "toolName": "query",
   *   "arguments": { "city": "Beijing" }
   * }
   * }</pre>
   *
   * <p>Or the shorthand form using fullName:
   *
   * <pre>{@code
   * {
   *   "fullName": "mcp.weather.query",
   *   "arguments": { "city": "Beijing" }
   * }
   * }</pre>
   */
  private String executeMcpCall(JsonNode args, String sessionId) {
    String serverId;
    String toolName;

    // Support both explicit serverId/toolName and fullName formats
    if (args.has("fullName")) {
      String fullName = args.get("fullName").asText();
      // Parse: mcp.<serverId>.<toolName>
      String stripped = fullName.startsWith("mcp.") ? fullName.substring(4) : fullName;
      String[] parts = stripped.split("\\.", 2);
      if (parts.length < 2) {
        return "{\"ok\":false,\"error\":\"Invalid MCP tool fullName: " + fullName + "\"}";
      }
      serverId = parts[0];
      toolName = parts[1];
    } else {
      serverId = args.has("serverId") ? args.get("serverId").asText() : "";
      toolName = args.has("toolName") ? args.get("toolName").asText() : "";
    }

    if (serverId.isEmpty() || toolName.isEmpty()) {
      return "{\"ok\":false,\"error\":\"mcp.call requires serverId and toolName (or fullName)\"}";
    }

    JsonNode arguments = args.has("arguments") ? args.get("arguments") : mapper.createObjectNode();
    log.info(
        "Executing MCP tool call: server={}, tool={}, session={}", serverId, toolName, sessionId);
    return mcpToolExecutor.execute(sessionId, serverId, toolName, arguments);
  }
}

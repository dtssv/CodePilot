package io.codepilot.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.codepilot.core.dto.ConversationRunRequest.UserMcp;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Executes MCP tool calls on the backend side.
 *
 * <p>When the LLM produces an {@code infoRequest} with {@code kind="mcp.call"}, this component
 * dispatches the call to the appropriate MCP server via HTTP/SSE transport.
 *
 * <p>MCP server addresses and tool metadata are derived from the {@code userMcps[]} field in the
 * conversation request. The backend does NOT manage MCP server processes — that is the plugin's
 * responsibility. For SSE/Streamable HTTP MCP servers, the backend connects directly; for
 * stdio-based servers, the call must be routed back to the plugin (client-side).
 *
 * <h3>Transport Modes:</h3>
 *
 * <ul>
 *   <li><b>Streamable HTTP</b>: Direct HTTP POST with JSON-RPC — backend can call directly
 *   <li><b>SSE</b>: HTTP POST to the server's message endpoint — backend can call directly
 *   <li><b>stdio</b>: Requires local process — backend delegates back to client-side
 * </ul>
 */
@Component
public class McpToolExecutor {

  private static final Logger log = LoggerFactory.getLogger(McpToolExecutor.class);
  private static final Duration CALL_TIMEOUT = Duration.ofSeconds(30);

  private final ObjectMapper mapper;
  private final HttpClient httpClient;

  /** Session-scoped MCP configurations: sessionId -> list of UserMcp */
  private final ConcurrentHashMap<String, List<UserMcp>> sessionMcps = new ConcurrentHashMap<>();

  /** Session-scoped MCP tool metadata cache: sessionId -> list of tool descriptors */
  private final ConcurrentHashMap<String, List<Map<String, Object>>> sessionToolCache =
      new ConcurrentHashMap<>();

  public McpToolExecutor(ObjectMapper mapper) {
    this.mapper = mapper;
    this.httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
  }

  /** Register MCP configurations for a session. Called when a new conversation run starts. */
  public void registerSession(String sessionId, List<UserMcp> mcps) {
    if (mcps != null && !mcps.isEmpty()) {
      sessionMcps.put(sessionId, mcps);
      log.info("Registered {} MCP configs for session {}", mcps.size(), sessionId);
    }
  }

  /** Clean up session-scoped MCP data when the session ends. */
  public void unregisterSession(String sessionId) {
    sessionMcps.remove(sessionId);
    sessionToolCache.remove(sessionId);
  }

  /**
   * Register MCP tool metadata for a session. Called after the plugin sends the tools/list results
   * from each MCP server.
   */
  public void registerSessionTools(String sessionId, List<Map<String, Object>> tools) {
    if (tools != null && !tools.isEmpty()) {
      sessionToolCache.put(sessionId, tools);
      log.info("Registered {} MCP tools for session {}", tools.size(), sessionId);
    }
  }

  /** Get the cached tool metadata for a session. */
  public List<Map<String, Object>> getSessionTools(String sessionId) {
    return sessionToolCache.getOrDefault(sessionId, List.of());
  }

  /** Get the MCP configs for a session. */
  public List<UserMcp> getSessionMcps(String sessionId) {
    return sessionMcps.getOrDefault(sessionId, List.of());
  }

  /**
   * Execute an MCP tool call.
   *
   * @param sessionId the current session ID
   * @param serverId the MCP server ID (extracted from the tool name, e.g. "weather" from
   *     "mcp.weather.query")
   * @param toolName the tool name on the MCP server (e.g. "query")
   * @param args the tool arguments as a JsonNode
   * @return JSON string of the result
   */
  public String execute(String sessionId, String serverId, String toolName, JsonNode args) {
    List<UserMcp> mcps = sessionMcps.get(sessionId);
    if (mcps == null || mcps.isEmpty()) {
      return errorJson("No MCP servers configured for session " + sessionId);
    }

    // Find the MCP server config
    UserMcp mcp = mcps.stream().filter(m -> serverId.equals(m.id())).findFirst().orElse(null);

    if (mcp == null) {
      return errorJson("MCP server not found: " + serverId);
    }

    // Extract connection info from permissions
    Map<String, Object> permissions = mcp.permissions();
    if (permissions == null) {
      return errorJson("No permissions configured for MCP server: " + serverId);
    }

    String transport = (String) permissions.getOrDefault("transport", "stdio");
    String url = (String) permissions.getOrDefault("url", "");

    // stdio servers cannot be called from the backend — they need the plugin process
    if ("stdio".equals(transport)) {
      return errorJson(
          "stdio MCP server '"
              + serverId
              + "' requires client-side execution. "
              + "The backend cannot call stdio-based MCP servers directly.");
    }

    if (url == null || url.isBlank()) {
      return errorJson("Missing URL for remote MCP server: " + serverId);
    }

    try {
      // Build JSON-RPC request
      ObjectNode request = mapper.createObjectNode();
      request.put("jsonrpc", "2.0");
      request.put("id", 1);
      request.put("method", "tools/call");

      ObjectNode params = mapper.createObjectNode();
      params.put("name", toolName);
      if (args != null && !args.isNull()) {
        params.set("arguments", args);
      } else {
        params.putObject("arguments");
      }
      request.set("params", params);

      // Execute HTTP POST
      String requestBody = mapper.writeValueAsString(request);
      HttpRequest.Builder reqBuilder =
          HttpRequest.newBuilder()
              .uri(URI.create(url))
              .timeout(CALL_TIMEOUT)
              .header("Content-Type", "application/json")
              .POST(HttpRequest.BodyPublishers.ofString(requestBody));

      // Add custom headers if configured
      @SuppressWarnings("unchecked")
      Map<String, String> headers = (Map<String, String>) permissions.get("headers");
      if (headers != null) {
        headers.forEach(reqBuilder::header);
      }

      HttpRequest httpRequest = reqBuilder.build();
      HttpResponse<String> response =
          httpClient.send(httpRequest, HttpResponse.BodyHandlers.ofString());

      if (response.statusCode() >= 200 && response.statusCode() < 300) {
        // Parse the JSON-RPC response
        JsonNode responseNode = mapper.readTree(response.body());
        if (responseNode.has("error")) {
          JsonNode error = responseNode.get("error");
          return errorJson("MCP server error: " + error.path("message").asText("unknown"));
        }
        JsonNode result = responseNode.get("result");
        return mapper.writeValueAsString(
            Map.of(
                "ok",
                true,
                "serverId",
                serverId,
                "toolName",
                toolName,
                "result",
                result != null ? mapper.treeToValue(result, Object.class) : null));
      } else {
        return errorJson(
            "MCP server HTTP error: "
                + response.statusCode()
                + " - "
                + response.body().substring(0, Math.min(response.body().length(), 200)));
      }
    } catch (Exception e) {
      log.error("MCP tool call failed: server={}, tool={}", serverId, toolName, e);
      return errorJson("MCP tool call failed: " + e.getMessage());
    }
  }

  /**
   * Build a list of available MCP tool descriptors for prompt injection. Format: each entry has
   * "fullName" (e.g. "mcp.weather.query"), "description", and "parameters".
   */
  public List<Map<String, Object>> buildAvailableToolDescriptors(String sessionId) {
    return sessionToolCache.getOrDefault(sessionId, List.of());
  }

  private String errorJson(String message) {
    try {
      return mapper.writeValueAsString(Map.of("ok", false, "error", message));
    } catch (Exception e) {
      return "{\"ok\":false,\"error\":\"" + message.replace("\"", "'") + "\"}";
    }
  }
}

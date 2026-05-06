package io.codepilot.core.rag;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
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
 * </ul>
 */
@Component
public class ServerToolExecutor {

  private static final Logger log = LoggerFactory.getLogger(ServerToolExecutor.class);

  private final RagService ragService;
  private final ObjectMapper mapper;

  public ServerToolExecutor(RagService ragService, ObjectMapper mapper) {
    this.ragService = ragService;
    this.mapper = mapper;
  }

  /**
   * Returns true if the given tool name is a server-side tool.
   */
  public boolean isServerTool(String toolName) {
    return "rag.search".equals(toolName);
  }

  /**
   * Executes a server-side tool and returns a JSON result string.
   *
   * @param toolName the tool name (e.g. "rag.search")
   * @param args the arguments as a JSON object node
   * @param sessionId the current session ID
   * @return JSON string of the result
   */
  public String execute(String toolName, JsonNode args, String sessionId) {
    return switch (toolName) {
      case "rag.search" -> executeRagSearch(args, sessionId);
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
}
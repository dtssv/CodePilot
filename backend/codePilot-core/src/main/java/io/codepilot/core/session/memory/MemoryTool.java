package io.codepilot.core.session.memory;

import io.codepilot.core.agent.tool.ToolResult;
import io.codepilot.core.session.tool.ToolDefinition;
import io.codepilot.core.session.tool.ToolExecutor;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: `memory` — agent can read/write/search/delete memories. */
@Component
public class MemoryTool {

  private final MemoryService memoryService;

  public MemoryTool(MemoryService memoryService) {
    this.memoryService = memoryService;
  }

  public ToolDefinition definition() {
    return new ToolDefinition(
        "memory",
        "Manage persistent memory. Actions: read, search, write, delete. Memory persists across"
            + " sessions.",
        Map.of(
            "type", "object",
            "properties",
                Map.of(
                    "action",
                        Map.of(
                            "type", "string",
                            "enum", List.of("read", "search", "write", "delete"),
                            "description", "The memory action to perform"),
                    "query",
                        Map.of(
                            "type", "string", "description", "Search query (for 'search' action)"),
                    "content",
                        Map.of(
                            "type",
                            "string",
                            "description",
                            "Content to write (for 'write' action)"),
                    "type",
                        Map.of(
                            "type",
                            "string",
                            "enum",
                            List.of(
                                "persistent",
                                "global",
                                "session",
                                "checkpoint",
                                "notes",
                                "distilled"),
                            "description",
                            "Memory layer: persistent (project), global (user-wide), session, "
                                + "checkpoint, notes (scratchpad), distilled. Default: persistent"),
                    "id",
                        Map.of("type", "string", "description", "Entry ID (for 'delete' action)")),
            "required", List.of("action")),
        false, // readOnly
        true // requiresPermission
        );
  }

  public ToolExecutor executor() {
    return call -> {
      @SuppressWarnings("unchecked")
      Map<String, Object> args = call.args();
      String action = (String) args.get("action");
      if (action == null) return new ToolResult(false, "Missing required parameter: action");

      String sessionId = call.sessionId();

      return switch (action) {
        case "read" -> {
          String memory = memoryService.formatForPrompt(memoryService.loadRelevant("", sessionId));
          yield new ToolResult(true, memory.isBlank() ? "No memories found." : memory);
        }
        case "search" -> {
          String query = (String) args.getOrDefault("query", "");
          var results = memoryService.search(query, sessionId, 10);
          if (results.isEmpty()) yield new ToolResult(true, "No matching memories found.");
          StringBuilder sb = new StringBuilder("Found " + results.size() + " memories:\n\n");
          for (var entry : results) {
            sb.append("[").append(entry.getType()).append("] ");
            int len = Math.min(200, entry.getContent().length());
            sb.append(entry.getContent(), 0, len);
            if (entry.getContent().length() > 200) sb.append("...");
            sb.append("\n\n");
          }
          yield new ToolResult(true, sb.toString());
        }
        case "write" -> {
          String content = (String) args.get("content");
          if (content == null || content.isBlank())
            yield new ToolResult(false, "Missing 'content' parameter");
          String type = (String) args.getOrDefault("type", "persistent");
          memoryService.writeMemory(sessionId, type, content);
          yield new ToolResult(true, "Memory entry saved (" + type + " layer).");
        }
        case "delete" -> {
          String id = (String) args.get("id");
          if (id == null || id.isBlank()) yield new ToolResult(false, "Missing 'id' parameter");
          memoryService.deleteMemory(id);
          yield new ToolResult(true, "Memory entry deleted.");
        }
        default -> new ToolResult(false, "Unknown action: " + action);
      };
    };
  }
}

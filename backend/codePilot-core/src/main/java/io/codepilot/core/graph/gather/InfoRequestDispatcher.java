package io.codepilot.core.graph.gather;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.rag.ServerToolExecutor;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.concurrent.CompletableFuture;

/**
 * Dispatches info requests to either client-side (via tool_call SSE) or
 * server-side (RAG, HTTP fetch) executors.
 *
 * <p>MCP tool calls ({@code mcp.call}) are always routed to the plugin so stdio
 * and local process transports work reliably.
 */
@Component
public class InfoRequestDispatcher {

    private static final Set<String> CLIENT_SIDE_KINDS = Set.of(
            "fs.read", "fs.list", "fs.grep",
            "code.outline", "code.symbol", "code.usages",
            "shell.exec",
            "mcp.call"
    );

    private static final Set<String> SERVER_SIDE_KINDS = Set.of(
            "rag.search", "http.fetch"
    );

    private final ServerToolExecutor serverToolExecutor;
    private final ObjectMapper mapper;

    public InfoRequestDispatcher(ServerToolExecutor serverToolExecutor, ObjectMapper mapper) {
        this.serverToolExecutor = serverToolExecutor;
        this.mapper = mapper;
    }

    /**
     * Classifies requests into client-side and server-side groups.
     */
    public DispatchResult classify(List<Map<String, Object>> requests) {
        List<Map<String, Object>> clientRequests = new ArrayList<>();
        List<Map<String, Object>> serverRequests = new ArrayList<>();

        for (Map<String, Object> req : requests) {
            String kind = (String) req.get("kind");
            if (CLIENT_SIDE_KINDS.contains(kind)) {
                clientRequests.add(req);
            } else if (SERVER_SIDE_KINDS.contains(kind)) {
                serverRequests.add(req);
            }
        }
        return new DispatchResult(clientRequests, serverRequests);
    }

    /**
     * Executes server-side requests in parallel and returns results.
     */
    public List<Map<String, Object>> executeServerSide(List<Map<String, Object>> requests) {
        List<Map<String, Object>> results = new ArrayList<>();
        for (Map<String, Object> req : requests) {
            String id = (String) req.get("id");
            String kind = (String) req.get("kind");
            try {
                @SuppressWarnings("unchecked")
                Map<String, Object> args = (Map<String, Object>) req.getOrDefault("args", Map.of());
                String sessionId = (String) req.getOrDefault("sessionId", "");
                var argsNode = mapper.valueToTree(args);
                String result = serverToolExecutor.execute(kind, argsNode, sessionId);
                @SuppressWarnings("unchecked")
                Map<String, Object> resultMap = mapper.readValue(result, Map.class);
                results.add(Map.of("id", id, "kind", kind, "ok", true, "result", resultMap));
            } catch (Exception e) {
                results.add(Map.of("id", id, "kind", kind, "ok", false,
                        "errorCode", "server_error", "errorMessage", e.getMessage()));
            }
        }
        return results;
    }

    public record DispatchResult(List<Map<String, Object>> clientSide, List<Map<String, Object>> serverSide) {}
}

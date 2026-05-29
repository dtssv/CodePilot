package io.codepilot.core.graph.gather;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.graph.GatherResultCache;
import io.codepilot.core.graph.GraphExecutionLog;
import io.codepilot.core.graph.GraphExecutionMetrics;
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
    private final GatherResultCache gatherResultCache;
    private final GraphExecutionMetrics graphExecutionMetrics;

    public InfoRequestDispatcher(
            ServerToolExecutor serverToolExecutor,
            ObjectMapper mapper,
            GatherResultCache gatherResultCache,
            GraphExecutionMetrics graphExecutionMetrics) {
        this.serverToolExecutor = serverToolExecutor;
        this.mapper = mapper;
        this.gatherResultCache = gatherResultCache;
        this.graphExecutionMetrics = graphExecutionMetrics;
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
        return executeServerSide(requests, "", "");
    }

    /**
     * Executes server-side requests with optional result caching for read-only tools.
     *
     * @param projectRootHash scopes cache entries to a workspace
     * @param sessionId       used for cache-hit logging
     */
    public List<Map<String, Object>> executeServerSide(
            List<Map<String, Object>> requests, String projectRootHash, String sessionId) {
        List<Map<String, Object>> results = new ArrayList<>();
        for (Map<String, Object> req : requests) {
            String id = (String) req.get("id");
            String kind = (String) req.get("kind");
            try {
                @SuppressWarnings("unchecked")
                Map<String, Object> args = (Map<String, Object>) req.getOrDefault("args", Map.of());
                if (gatherResultCache.isCacheable(kind)) {
                    var cached = gatherResultCache.get(kind, args, projectRootHash);
                    if (cached.isPresent()) {
                        GraphExecutionLog.gatherCacheHit(sessionId, kind, id);
                        graphExecutionMetrics.recordGatherCacheHit(kind);
                        results.add(rebindRequestId(cached.get(), id, kind));
                        continue;
                    }
                }

                String reqSessionId = (String) req.getOrDefault("sessionId", sessionId);
                var argsNode = mapper.valueToTree(args);
                String result = serverToolExecutor.execute(kind, argsNode, reqSessionId);
                @SuppressWarnings("unchecked")
                Map<String, Object> resultMap = mapper.readValue(result, Map.class);
                Map<String, Object> entry = Map.of("id", id, "kind", kind, "ok", true, "result", resultMap);
                gatherResultCache.put(kind, args, projectRootHash, entry);
                results.add(entry);
            } catch (Exception e) {
                results.add(Map.of("id", id, "kind", kind, "ok", false,
                        "errorCode", "server_error", "errorMessage", e.getMessage()));
            }
        }
        return results;
    }

    private static Map<String, Object> rebindRequestId(
            Map<String, Object> cached, String id, String kind) {
        return Map.of(
                "id", id,
                "kind", kind,
                "ok", cached.getOrDefault("ok", true),
                "result", cached.get("result"));
    }

    public record DispatchResult(List<Map<String, Object>> clientSide, List<Map<String, Object>> serverSide) {}
}

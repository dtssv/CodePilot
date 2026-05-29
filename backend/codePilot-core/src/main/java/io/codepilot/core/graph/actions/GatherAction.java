package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.conversation.ToolResultBus;
import io.codepilot.core.conversation.ToolResultBus.ToolResultEvent;
import io.codepilot.core.graph.*;
import io.codepilot.core.graph.gather.InfoRequestDispatcher;
import io.codepilot.core.graph.gather.InfoRequestValidator;
import io.codepilot.core.sse.SseEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import java.time.Duration;
import java.util.*;

/**
 * Gather node: collects read-only information needed before proceeding.
 *
 * Flow:
 * 1. Extract infoRequests from graph state (produced by Planning/Generate/Repair)
 * 2. Validate requests via InfoRequestValidator
 * 3. Classify into client-side (fs.read, code.outline, ide.diagnostics) and server-side (rag.search, mcp.call)
 * 4. Execute server-side requests via InfoRequestDispatcher
 * 5. Emit graph_info_request SSE for client-side requests
 * 6. Collect all results into gatheredInfo state for Reenter to inject
 */
@Component
public class GatherAction implements NodeAction {
    private static final Logger log = LoggerFactory.getLogger(GatherAction.class);
    private static final Duration CLIENT_RESULT_TIMEOUT = Duration.ofSeconds(60);

    private final InfoRequestDispatcher dispatcher;
    private final InfoRequestValidator validator;
    private final ToolResultBus toolResultBus;

    public GatherAction(InfoRequestDispatcher dispatcher, InfoRequestValidator validator, ToolResultBus toolResultBus) {
        this.dispatcher = dispatcher;
        this.validator = validator;
        this.toolResultBus = toolResultBus;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "gather");
        GraphExecutionLog.nodeEnter(state, "gather");

        String phaseId = (String) state.value("phaseCursor").orElse("");
        var rawRequests = normalizeInfoRequests(state.value("infoRequests").orElse(List.of()));

        if (rawRequests.isEmpty()) {
            log.debug("Gather: no info requests, skipping");
            updates.put("gatheredInfo", Map.of());
            return updates;
        }

        GraphUiEmitter.transition(state, "gather");

        // 1. Validate requests (validate throws on invalid batch)
        List<Map<String, Object>> validRequests = new ArrayList<>();
        List<String> validationErrors = new ArrayList<>();
        boolean allowMutatingShell =
                Boolean.TRUE.equals(state.value("allowShellExec").orElse(false));
        try {
            validator.validate(rawRequests, allowMutatingShell);
            validRequests.addAll(rawRequests);
        } catch (IllegalArgumentException e) {
            log.warn("Gather: validation failed: {}", e.getMessage());
            validationErrors.add(e.getMessage());
        }

        if (!validationErrors.isEmpty()) {
            log.warn("Gather: {} validation errors out of {}", validationErrors.size(), rawRequests.size());
        }

        // 2. Classify into server-side and client-side
        var dispatchResult = dispatcher.classify(validRequests);
        var serverRequests = dispatchResult.serverSide();
        var clientRequests = dispatchResult.clientSide();

        // 3. Execute server-side requests
        Map<String, Object> gatheredInfo = new HashMap<>();
        // ★ Inject sessionId into server-side requests (needed for mcp.call to look up session-scoped MCP config)
        String currentSessionId = (String) state.value("sessionId").orElse("");
        for (Map<String, Object> serverReq : serverRequests) {
            serverReq.putIfAbsent("sessionId", currentSessionId);
        }
        String projectRootHash = (String) state.value("projectRootHash").orElse("");
        var serverResults =
                dispatcher.executeServerSide(serverRequests, projectRootHash, currentSessionId);
        for (var result : serverResults) {
            String key = result.get("id") != null ? (String) result.get("id") : UUID.randomUUID().toString();
            gatheredInfo.put(key, result);
        }

        // 4. Emit client-side requests via SSE as a batch tool_call, then await results
        if (!clientRequests.isEmpty()) {
            String gatherToolCallId = UUID.randomUUID().toString();
            String sessionId = (String) state.value("sessionId").orElse("");

            // ★ Interactive Agent: emit agent_thinking before reading files
            // Use the agentGatherIntent from the previous LLM output (Planning/Generate)
            // which already explains WHY the files need to be read.
            String thinkingText = (String) state.value("agentGatherIntent").orElse("");
            if (thinkingText.isBlank()) {
                thinkingText = "让我先收集所需信息。";
            }
            GraphSseHelper.emitEvent(state, SseEvents.AGENT_THINKING,
                Map.of("text", thinkingText, "phaseId", phaseId));

            // IMPORTANT: Register the future BEFORE emitting the SSE event, otherwise a fast
            // client response can arrive before the future is registered, causing publish() to
            // find no pending future → result lost → timeout → re-gather loop.
            var pendingFuture = ToolResultBus.registerFuture(sessionId, gatherToolCallId);

            // Emit a tool_call SSE so the client knows to execute and return results
            // via the ToolResultBus (same pattern as ApplyPatchAction/VerifyAction)
            var gatherArgs = Map.of("phaseId", phaseId, "requests", clientRequests);
            GraphExecutionLog.toolCallEmit(state, gatherToolCallId, "gather.execute", gatherArgs);
            GraphSseHelper.emitEvent(state, SseEvents.TOOL_CALL, Map.of(
                "id", gatherToolCallId,
                "name", "gather.execute",
                "args", gatherArgs
            ));

            // Also emit the legacy graph_info_request event for UI display
            GraphSseHelper.emitEvent(state, SseEvents.GRAPH_INFO_REQUEST,
                Map.of("phaseId", phaseId, "requests", clientRequests, "toolCallId", gatherToolCallId));

            // ── Block and wait for client results via ToolResultBus (CompletableFuture) ──
            ToolResultEvent result;
            try {
                log.info("Gather: waiting for client results, sessionId={}, toolCallId={}, timeout={}s",
                        sessionId, gatherToolCallId, CLIENT_RESULT_TIMEOUT.toSeconds());
                result = GraphToolWaitHelper.await(
                        pendingFuture, state, "读取文件中", CLIENT_RESULT_TIMEOUT);
                log.info("Gather: received client results for toolCallId={}, ok={}", gatherToolCallId,
                        result != null && result.ok());
                if (result != null) {
                    GraphExecutionLog.toolResultAwait(
                            state, gatherToolCallId, result.ok(), result.errorMessage());
                }
            } catch (Exception e) {
                ToolResultBus.unregisterFuture(sessionId, gatherToolCallId);
                result = null;
                if (e instanceof java.util.concurrent.TimeoutException) {
                    log.warn("Gather: timeout waiting for client results toolCallId={}", gatherToolCallId);
                } else {
                    log.warn("Gather: error waiting for client results toolCallId={}", gatherToolCallId, e);
                }
            }

            if (result != null && result.result() != null) {
                // ★ FIX: Merge client results even when ok=false (partial failure).
                // The plugin sets ok=false if ANY sub-request fails, but successful
                // sub-results are still in result.gathered[]. We must not discard them.
                mergeClientResults(gatheredInfo, result.result());

                // Count successes and failures from the per-request results
                int successCount = 0;
                int failCount = 0;
                if (result.result() instanceof Map<?, ?> resultMap
                        && resultMap.get("gathered") instanceof List<?> gathered) {
                    for (Object item : gathered) {
                        if (item instanceof Map<?, ?> g) {
                            Object okVal = g.get("ok");
                            if (Boolean.TRUE.equals(okVal)) {
                                successCount++;
                            } else {
                                failCount++;
                            }
                        }
                    }
                }

                if (result.ok()) {
                    log.info("Gather: received client results for {} requests via toolCallId={}",
                            clientRequests.size(), gatherToolCallId);
                } else {
                    log.warn("Gather: partial failure — {} succeeded, {} failed out of {} requests (toolCallId={})",
                            successCount, failCount, clientRequests.size(), gatherToolCallId);
                }

                // ★ Interactive Agent: emit agent_reading with human-readable summary
                String readingSummary = buildGatherReadingSummary(clientRequests, result.result());
                // Build file list for the frontend (only from successful fs.read/fs.list)
                List<Map<String, String>> readingFiles = clientRequests.stream()
                    .filter(r -> "fs.read".equals(r.get("kind")) || "fs.list".equals(r.get("kind")))
                    .map(r -> {
                        var args = r.get("args");
                        String path = "";
                        if (args instanceof Map<?, ?> m) {
                            Object p = m.get("path");
                            if (p != null) path = p.toString();
                        }
                        return Map.of("path", path, "op", String.valueOf(r.getOrDefault("kind", "")));
                    })
                    .filter(f -> !f.get("path").isEmpty())
                    .toList();
                if (successCount > 0) {
                    GraphSseHelper.emitEvent(state, SseEvents.AGENT_READING,
                        Map.of("summary", readingSummary, "files", readingFiles, "fileCount", successCount, "phaseId", phaseId));
                }
            } else {
                String errMsg = result != null ? result.errorMessage() : "Timeout waiting for gather results";
                log.warn("Gather: client results failed or timed out: {}", errMsg);
                // Mark ALL requests as errors only when there is NO result at all (full timeout/failure)
                for (var req : clientRequests) {
                    String reqId = (String) req.getOrDefault("id", UUID.randomUUID().toString());
                    gatheredInfo.put(reqId, Map.of(
                            "id", reqId, "kind", req.getOrDefault("kind", "unknown"),
                            "ok", false, "errorCode", "gather_timeout",
                            "errorMessage", errMsg != null ? errMsg : "gather_timeout"));
                }
            }
        }

        // 5. Track gather loop count to prevent infinite gathering
        int gatherCount = (int) state.value("gatherCount").orElse(0) + 1;
        updates.put("gatherCount", gatherCount);
        updates.put("gatheredInfo", gatheredInfo);
        updates.put("clientRequestsPending", !clientRequests.isEmpty());
        // ★ Clear infoRequests so the next GenerateAction does not re-request the same files
        updates.put("infoRequests", List.of());

        // ★ Set gatherResumeTo so ReenterAction knows which node to return to after gather.
        // The value is the node that was active BEFORE this gather (i.e., the source
        // that routed to gather). Since GatherAction updates currentNode to "gather",
        // we check the prior value from state to determine the originating node.
        String priorNode = (String) state.value("currentNode").orElse("generate");
        // If priorNode is already "gather" (re-gather loop), preserve the original source
        String resumeTo = "gather".equals(priorNode)
                ? (String) state.value("gatherResumeTo").orElse("generate")
                : switch (priorNode) {
                    case "planning", "preCheck", "generate", "repair" -> priorNode;
                    default -> "generate";
                };
        updates.put("gatherResumeTo", resumeTo);

        // Enforce gather loop budget (max 3 per phase, max 5 total)
        // ★ Lowered from 10 to 5 — the routeAfterGenerate/routeAfterPlanning/routeAfterPreCheck
        // routers already block re-gather after 3 rounds; this is a secondary hard limit.
        if (gatherCount > 5) {
            log.warn("Gather: exceeded total gather budget (5), forcing continue");
            updates.put("gatherExhausted", true);
        }

        PhaseOutcomeHelper.recordGatheredOutcome(state, gatheredInfo, updates);
        ToolApproachTracker.recordFromRequests(state, clientRequests, gatheredInfo, updates);

        log.info("Gather: {} server + {} client requests processed (total gathers: {})",
            serverRequests.size(), clientRequests.size(), gatherCount);
        GraphExecutionLog.nodeExit(state, "gather", updates);
        return updates;
    }

    /**
     * Merges client-side gather results into the gatheredInfo map.
     * Handles both list and map result formats from the client.
     */
    @SuppressWarnings("unchecked")
    private void mergeClientResults(Map<String, Object> gatheredInfo, Object result) {
        if (result instanceof Map<?, ?> map) {
            // Check if it's wrapped in a "gathered" key (GatherDispatcher format)
            Object gathered = map.get("gathered");
            if (gathered instanceof List<?> list) {
                for (Object item : list) {
                    if (item instanceof Map<?, ?> entry) {
                        String id = extractStringId(entry);
                        gatheredInfo.put(id, (Map<String, Object>) entry);
                    }
                }
                return;
            }
            // Direct map result
            String id = extractStringId(map);
            gatheredInfo.put(id, (Map<String, Object>) map);
        } else if (result instanceof List<?> list) {
            for (Object item : list) {
                if (item instanceof Map<?, ?> entry) {
                    String id = extractStringId(entry);
                    gatheredInfo.put(id, (Map<String, Object>) entry);
                }
            }
        }
    }

    private static String extractStringId(Map<?, ?> map) {
        Object idVal = map.get("id");
        return idVal instanceof String s ? s : UUID.randomUUID().toString();
    }

    /**
     * Normalizes raw infoRequests from graph state into a type-safe List of Maps.
     * Handles cases where LLM or Jackson deserialization produces String elements
     * instead of Map elements (e.g., ["fs.read", "code.outline"]).
     */
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> normalizeInfoRequests(Object raw) {
        if (raw == null) return List.of();
        if (!(raw instanceof List<?> list)) return List.of();

        List<Map<String, Object>> result = new ArrayList<>();
        for (Object item : list) {
            if (item instanceof Map<?, ?> map) {
                result.add((Map<String, Object>) map);
            } else if (item instanceof String kind) {
                // LLM returned a shorthand string kind — wrap it as a proper request map
                log.warn("Gather: normalizing string infoRequest '{}' to Map form", kind);
                result.add(Map.of("kind", (Object) kind, "id", UUID.randomUUID().toString()));
            } else {
                log.warn("Gather: skipping unexpected infoRequest type: {}", item != null ? item.getClass() : "null");
            }
        }
        return result;
    }

    // ── Interactive Agent helper: build reading summary ──

    /**
     * Builds a simplified agent_reading summary after gather results are received.
     * Lists the files that were read, without attempting project-type detection
     * (which is better left to the LLM's semantic understanding).
     */
    @SuppressWarnings("unchecked")
    private String buildGatherReadingSummary(List<Map<String, Object>> requests, Object rawResult) {
        // Collect file paths from the requests
        List<String> filePaths = requests.stream()
            .filter(r -> "fs.read".equals(r.get("kind")))
            .map(r -> {
                var args = r.get("args");
                if (args instanceof Map<?, ?> m) {
                    Object p = m.get("path");
                    return p != null ? p.toString() : "";
                }
                return "";
            })
            .filter(p -> !p.isEmpty())
            .limit(5)
            .toList();

        long listCount = requests.stream().filter(r -> "fs.list".equals(r.get("kind"))).count();
        long readCount = requests.stream().filter(r -> "fs.read".equals(r.get("kind"))).count();

        StringBuilder sb = new StringBuilder("已获取所需信息");
        if (listCount > 0 && readCount > 0) {
            sb.append("，查看了目录结构并读取了 ").append(readCount).append(" 个文件");
        } else if (listCount > 0) {
            sb.append("，查看了目录结构");
        } else if (!filePaths.isEmpty()) {
            sb.append("，已读取 ").append(String.join("、", filePaths));
            if (readCount > 5) sb.append(" 等 ").append(readCount).append(" 个文件");
        }
        return sb.toString();
    }
}
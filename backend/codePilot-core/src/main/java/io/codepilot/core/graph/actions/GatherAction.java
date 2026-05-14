package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.conversation.ToolResultBus;
import io.codepilot.core.graph.GraphSseHelper;
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

        String phaseId = (String) state.value("phaseCursor").orElse("");
        var rawRequests = normalizeInfoRequests(state.value("infoRequests").orElse(List.of()));

        if (rawRequests.isEmpty()) {
            log.debug("Gather: no info requests, skipping");
            updates.put("gatheredInfo", Map.of());
            return updates;
        }

        // 1. Validate requests (validate throws on invalid batch)
        List<Map<String, Object>> validRequests = new ArrayList<>();
        List<String> validationErrors = new ArrayList<>();
        try {
            validator.validate(rawRequests);
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
        var serverResults = dispatcher.executeServerSide(serverRequests);
        for (var result : serverResults) {
            String key = (String) result.getOrDefault("id", UUID.randomUUID().toString());
            gatheredInfo.put(key, result);
        }

        // 4. Emit client-side requests via SSE as a batch tool_call, then await results
        if (!clientRequests.isEmpty()) {
            String gatherToolCallId = UUID.randomUUID().toString();

            // Emit a tool_call SSE so the client knows to execute and return results
            // via the ToolResultBus (same pattern as ApplyPatchAction/VerifyAction)
            GraphSseHelper.emitEvent(state, SseEvents.TOOL_CALL, Map.of(
                "id", gatherToolCallId,
                "name", "gather.execute",
                "args", Map.of("phaseId", phaseId, "requests", clientRequests)
            ));

            // Also emit the legacy graph_info_request event for UI display
            GraphSseHelper.emitEvent(state, SseEvents.GRAPH_INFO_REQUEST,
                Map.of("phaseId", phaseId, "requests", clientRequests, "toolCallId", gatherToolCallId));

            // ── Block and wait for client results via ToolResultBus ──
            try {
                String sessionId = (String) state.value("sessionId").orElse("");
                var result = toolResultBus.subscribe(sessionId)
                        .filter(e -> e.toolCallId().equals(gatherToolCallId))
                        .timeout(CLIENT_RESULT_TIMEOUT)
                        .blockFirst();

                if (result != null && result.ok() && result.result() != null) {
                    // Merge client results into gatheredInfo
                    mergeClientResults(gatheredInfo, result.result());
                    log.info("Gather: received client results for {} requests via toolCallId={}",
                            clientRequests.size(), gatherToolCallId);
                } else {
                    String errMsg = result != null ? result.errorMessage() : "Timeout waiting for gather results";
                    log.warn("Gather: client results failed or timed out: {}", errMsg);
                    // Mark failed requests as errors in gatheredInfo
                    for (var req : clientRequests) {
                        String reqId = (String) req.getOrDefault("id", UUID.randomUUID().toString());
                        gatheredInfo.put(reqId, Map.of(
                                "id", reqId, "kind", req.get("kind"),
                                "ok", false, "errorCode", "gather_timeout",
                                "errorMessage", errMsg));
                    }
                }
            } catch (Exception e) {
                log.warn("Gather: client results wait exception: {}", e.getMessage());
                for (var req : clientRequests) {
                    String reqId = (String) req.getOrDefault("id", UUID.randomUUID().toString());
                    gatheredInfo.put(reqId, Map.of(
                            "id", reqId, "kind", req.get("kind"),
                            "ok", false, "errorCode", "gather_error",
                            "errorMessage", e.getMessage()));
                }
            }
        }

        // 5. Track gather loop count to prevent infinite gathering
        int gatherCount = (int) state.value("gatherCount").orElse(0) + 1;
        updates.put("gatherCount", gatherCount);
        updates.put("gatheredInfo", gatheredInfo);
        updates.put("clientRequestsPending", !clientRequests.isEmpty());

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

        // Enforce gather loop budget (max 3 per phase, max 10 total)
        if (gatherCount > 10) {
            log.warn("Gather: exceeded total gather budget (10), forcing continue");
            updates.put("gatherExhausted", true);
        }

        log.info("Gather: {} server + {} client requests processed (total gathers: {})",
            serverRequests.size(), clientRequests.size(), gatherCount);
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
}
package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.graph.gather.InfoRequestDispatcher;
import io.codepilot.core.graph.gather.InfoRequestValidator;
import io.codepilot.core.sse.SseEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
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

    private final InfoRequestDispatcher dispatcher;
    private final InfoRequestValidator validator;

    public GatherAction(InfoRequestDispatcher dispatcher, InfoRequestValidator validator) {
        this.dispatcher = dispatcher;
        this.validator = validator;
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

        // 4. Emit client-side requests via SSE
        if (!clientRequests.isEmpty()) {
            GraphSseHelper.emitEvent(state, SseEvents.GRAPH_INFO_REQUEST,
                Map.of("phaseId", phaseId, "requests", clientRequests));
        }

        // 5. Track gather loop count to prevent infinite gathering
        int gatherCount = (int) state.value("gatherCount").orElse(0) + 1;
        updates.put("gatherCount", gatherCount);
        updates.put("gatheredInfo", gatheredInfo);
        updates.put("clientRequestsPending", !clientRequests.isEmpty());

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
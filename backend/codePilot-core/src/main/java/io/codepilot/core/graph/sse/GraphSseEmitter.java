package io.codepilot.core.graph.sse;

import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.Map;

/**
 * Constructs SSE event payloads for graph_* events.
 * Each method returns a Map that will be serialized to JSON and emitted as an SSE data field.
 */
@Component
public class GraphSseEmitter {

    public Map<String, Object> transition(String from, String to, String phaseId, String reason) {
        return Map.of("event", "graph_transition",
                "from", from, "to", to, "phaseId", phaseId, "reason", reason);
    }

    public Map<String, Object> graphPlan(Object phases, String graphId) {
        return Map.of("event", "graph_plan", "phases", phases, "graphId", graphId);
    }

    public Map<String, Object> infoRequest(String phaseId, Object requests) {
        return Map.of("event", "graph_info_request", "phaseId", phaseId, "requests", requests);
    }

    public Map<String, Object> infoResult(String phaseId, Object results) {
        return Map.of("event", "graph_info_result", "phaseId", phaseId, "results", results);
    }

    public Map<String, Object> verify(Object report) {
        return Map.of("event", "graph_verify", "report", report);
    }

    public Map<String, Object> repairPlan(String phaseId, int attempt, String strategy, Object targets) {
        return Map.of("event", "graph_repair_plan",
                "phaseId", phaseId, "attempt", attempt, "strategy", strategy, "targets", targets);
    }

    public Map<String, Object> phaseDone(String phaseId, String summary) {
        return Map.of("event", "graph_phase_done", "phaseId", phaseId, "summary", summary);
    }

    public Map<String, Object> budgetAlert(String phaseId, String kind, int value, int limit) {
        return Map.of("event", "graph_budget_alert",
                "phaseId", phaseId, "kind", kind, "value", value, "limit", limit);
    }

    public Map<String, Object> needsInput(Object payload) {
        return Map.of("event", "needs_input", "data", payload);
    }

    public Map<String, Object> done(String reason) {
        return Map.of("event", "done", "reason", reason);
    }

    public Map<String, Object> done(String reason, String continuationToken) {
        return Map.of("event", "done", "reason", reason, "continuationToken", continuationToken);
    }

    public Map<String, Object> error(String code, String message) {
        return Map.of("event", "error", "code", code, "message", message);
    }
}
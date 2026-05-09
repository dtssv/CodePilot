package io.codepilot.core.graph;

import java.util.*;

/**
 * Mutable graph execution state. Held in Redis (24h TTL) during a run;
 * the plugin-side copy in plans/graph-{n}.json is the authority after expiry.
 */
public class GraphState {

    private String sessionId;
    private String graphId;
    private String currentNode = "intake";
    private String phaseCursor = "";
    private List<Map<String, Object>> phases = new ArrayList<>();
    private final Map<String, Integer> attempts = new HashMap<>();
    private final List<Map<String, Object>> history = new ArrayList<>();
    private final List<Map<String, Object>> completedToolCalls = new ArrayList<>();
    private final List<Map<String, Object>> gathered = new ArrayList<>();
    private Map<String, Object> awaiting;
    private int gatherLoopCount = 0;

    // Transient: current gather request (not persisted beyond the current run)
    private List<Map<String, Object>> pendingGatherRequests;
    private String gatherResumeTo;

    public String getCurrentNode() { return currentNode; }
    public String getPhaseCursor() { return phaseCursor; }
    public String getSessionId() { return sessionId; }
    public String getGraphId() { return graphId; }
    public List<Map<String, Object>> getPhases() { return phases; }
    public Map<String, Integer> getAttempts() { return attempts; }
    public List<Map<String, Object>> getHistory() { return history; }
    public List<Map<String, Object>> getGathered() { return gathered; }
    public Map<String, Object> getAwaiting() { return awaiting; }
    public int getGatherLoopCount() { return gatherLoopCount; }

    public void setSessionId(String sessionId) { this.sessionId = sessionId; }
    public void setGraphId(String graphId) { this.graphId = graphId; }
    public void setPhaseCursor(String phaseCursor) { this.phaseCursor = phaseCursor; }
    public void setPhases(List<Map<String, Object>> phases) { this.phases = phases; }

    public void moveTo(String nodeId) {
        this.currentNode = nodeId;
        history.add(Map.of(
                "seq", history.size() + 1,
                "node", nodeId,
                "phaseId", phaseCursor,
                "at", System.currentTimeMillis()
        ));
    }

    public void incrementAttempt() {
        attempts.merge(phaseCursor, 1, Integer::sum);
    }

    public int currentAttempts() {
        return attempts.getOrDefault(phaseCursor, 0);
    }

    public void resetAttempts() {
        attempts.put(phaseCursor, 0);
    }

    public void setGatherRequest(List<Map<String, Object>> requests, String resumeTo) {
        this.pendingGatherRequests = requests;
        this.gatherResumeTo = resumeTo;
        this.gatherLoopCount++;
    }

    public List<Map<String, Object>> getPendingGatherRequests() { return pendingGatherRequests; }
    public String getGatherResumeTo() { return gatherResumeTo; }

    public void clearGatherRequest() {
        this.pendingGatherRequests = null;
        this.gatherResumeTo = null;
    }

    public void addGatheredResults(List<Map<String, Object>> results) {
        gathered.addAll(results);
    }

    public void setAwaiting(Map<String, Object> needsInput, String nextNode) {
        this.awaiting = new HashMap<>();
        this.awaiting.put("needsInput", needsInput);
        this.awaiting.put("nextNode", nextNode);
        this.awaiting.put("continuationToken", "ctk-" + UUID.randomUUID());
    }

    public void clearAwaiting() {
        this.awaiting = null;
    }

    public boolean isLastPhase() {
        if (phases.isEmpty() || phaseCursor.isEmpty()) return false;
        var lastPhase = phases.get(phases.size() - 1);
        return phaseCursor.equals(lastPhase.get("id"));
    }
}
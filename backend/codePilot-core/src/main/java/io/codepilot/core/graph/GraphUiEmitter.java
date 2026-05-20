package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.fasterxml.jackson.databind.JsonNode;
import io.codepilot.core.sse.SseEvents;
import java.util.Map;

/** Model-driven user-visible SSE (no fixed status copy). */
public final class GraphUiEmitter {

  private GraphUiEmitter() {}

  /** Internal graph transition only (no fixed running banner). */
  public static void transition(OverAllState state, String node) {
    String phaseId = (String) state.value("phaseCursor").orElse("");
    GraphSseHelper.emitEvent(
        state, SseEvents.GRAPH_TRANSITION, Map.of("to", node, "phaseId", phaseId));
  }

  public static void thinkingIfPresent(OverAllState state, JsonNode root, String phaseId) {
    thinkingIfPresent(state, root, phaseId, false);
  }

  public static void thinkingIfPresent(
      OverAllState state, JsonNode root, String phaseId, boolean alreadyEmitted) {
    if (alreadyEmitted || root == null) {
      return;
    }
    JsonNode n = root.get("agentThinking");
    if (n != null && !n.isNull() && !n.asText("").isBlank()) {
      GraphSseHelper.emitEvent(
          state, SseEvents.AGENT_THINKING, Map.of("text", n.asText(), "phaseId", phaseId));
    }
  }

  public static void thinkingIfPresent(
      OverAllState state, String text, String phaseId, boolean alreadyEmitted) {
    if (alreadyEmitted || text == null || text.isBlank()) {
      return;
    }
    GraphSseHelper.emitEvent(
        state, SseEvents.AGENT_THINKING, Map.of("text", text, "phaseId", phaseId));
  }

  public static void contentIfPresent(
      OverAllState state, String text, boolean alreadyStreamed) {
    if (alreadyStreamed || text == null || text.isBlank()) {
      return;
    }
    String cleaned = GraphContentSanitizer.stripForDisplay(text);
    if (cleaned.isBlank()) {
      return;
    }
    GraphSseHelper.emitEvent(state, SseEvents.DELTA, Map.of("text", cleaned + "\n\n"));
  }

  public static void contentIfPresent(OverAllState state, JsonNode root, boolean alreadyStreamed) {
    if (alreadyStreamed || root == null) {
      return;
    }
    JsonNode n = root.get("agentContent");
    if (n != null && !n.isNull() && !n.asText("").isBlank()) {
      String cleaned = GraphContentSanitizer.stripForDisplay(n.asText());
      if (!cleaned.isBlank()) {
        GraphSseHelper.emitEvent(state, SseEvents.DELTA, Map.of("text", cleaned + "\n\n"));
      }
    }
  }
}

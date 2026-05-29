package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.sse.SseEvents;
import java.util.Map;

/**
 * Marker-aware LLM stream processor.
 *
 * <ul>
 *   <li>Structured envelope mode: drops plain-text preamble before markers/JSON (avoids duplicate essays)
 *   <li>{@code <<<AGENT_CONTENT>>>} … {@code <<<END>>>} → stream first block only as {@code delta}
 *   <li>{@code <<<AGENT_THINKING>>>} … {@code <<<END>>>} → emit {@code agent_thinking} once
 *   <li>{@code <<<GRAPH_JSON>>>} … {@code <<<END>>>} or raw {@code {...}} → buffer for parse
 * </ul>
 */
public final class GraphStreamProcessor {

  public static final String MARKER_GRAPH = "<<<GRAPH_JSON>>>";
  public static final String MARKER_CONTENT = "<<<AGENT_CONTENT>>>";
  public static final String MARKER_THINKING = "<<<AGENT_THINKING>>>";
  public static final String MARKER_WRITING = "<<<AGENT_WRITING>>>";
  public static final String MARKER_READING = "<<<AGENT_READING>>>";
  public static final String MARKER_END = "<<<END>>>";

  private enum Mode {
    DETECT,
    PLAIN,
    JSON_BUFFER,
    IN_MARKER
  }

  private final OverAllState state;
  /** When true, only marker blocks are streamed — plain preamble before markers is discarded. */
  private final boolean dropPlainPreamble;
  private final StringBuilder pending = new StringBuilder();
  private final StringBuilder markerBody = new StringBuilder();
  private Mode mode = Mode.DETECT;
  private String activeMarker;
  private boolean agentContentStreamed;
  private boolean agentThinkingEmitted;
  private boolean plainTextStreamed;

  public GraphStreamProcessor(OverAllState state) {
    this(state, false);
  }

  public GraphStreamProcessor(OverAllState state, boolean dropPlainPreamble) {
    this.state = state;
    this.dropPlainPreamble = dropPlainPreamble;
  }

  public boolean agentContentStreamed() {
    return agentContentStreamed;
  }

  public boolean agentThinkingEmitted() {
    return agentThinkingEmitted;
  }

  public boolean plainTextStreamed() {
    return plainTextStreamed;
  }

  public void onChunk(String chunk) {
    if (chunk == null || chunk.isBlank()) {
      return;
    }
    pending.append(chunk);
    drain();
  }

  /** Flush tail after the LLM stream completes. */
  public void finish() {
    drain();
    if (mode == Mode.IN_MARKER && activeMarker == null) {
      int markerAt = indexOfAnyMarker(pending);
      if (markerAt >= 0) {
        startMarkerAt(markerAt);
      }
    }
    if (mode == Mode.IN_MARKER && activeMarker != null) {
      int endAt = GraphMarkerSanitizer.indexOfEndMarker(pending);
      if (endAt >= 0) {
        int endLen = GraphMarkerSanitizer.endMarkerLength(pending, endAt);
        markerBody.append(pending.substring(0, endAt));
        pending.delete(0, endAt + endLen);
      } else if (!pending.isEmpty()) {
        markerBody.append(pending);
        pending.setLength(0);
      }
      closeMarker();
      mode = Mode.DETECT;
      drain();
    }
    if (mode == Mode.JSON_BUFFER) {
      pending.setLength(0);
    } else if (mode == Mode.PLAIN && !pending.isEmpty()) {
      if (!dropPlainPreamble && !GraphJsonLeakGuard.looksLikeGraphGenerateJson(pending)) {
        emitPlain(pending.toString());
      }
      pending.setLength(0);
    }
    pending.setLength(0);
  }

  private void drain() {
    boolean progress = true;
    int guard = 0;
    while (progress && guard++ < 64) {
      progress = false;
      switch (mode) {
        case DETECT -> progress = drainDetect();
        case PLAIN -> progress = drainPlain();
        case JSON_BUFFER -> progress = false;
        case IN_MARKER -> progress = drainMarker();
        default -> progress = false;
      }
    }
  }

  private boolean drainDetect() {
    if (pending.isEmpty()) {
      return false;
    }
    int markerAt = indexOfAnyMarker(pending);
    if (markerAt >= 0) {
      int lead = leadingWhitespaceLength(pending);
      if (markerAt > lead) {
        mode = Mode.PLAIN;
        return true;
      }
      if (markerAt > 0) {
        pending.delete(0, markerAt);
      }
      startMarkerAt(0);
      return true;
    }
    int braceAt = pending.indexOf("{");
    if (braceAt == 0) {
      mode = Mode.JSON_BUFFER;
      return false;
    }
    if (braceAt > 0) {
      if (GraphJsonLeakGuard.looksLikeGraphGenerateJson(pending.substring(braceAt))) {
        mode = Mode.JSON_BUFFER;
        return true;
      }
      mode = Mode.PLAIN;
      return true;
    }
    String trimmed = pending.toString().stripLeading();
    if (!trimmed.isEmpty()) {
      mode = Mode.PLAIN;
      return true;
    }
    return false;
  }

  private boolean drainPlain() {
    int markerAt = indexOfAnyMarker(pending);
    int jsonAt = pending.indexOf("{");

    if (markerAt == 0) {
      startMarkerAt(0);
      return true;
    }
    if (jsonAt == 0) {
      mode = Mode.JSON_BUFFER;
      return true;
    }

    int cut = pending.length();
    if (markerAt > 0) {
      cut = Math.min(cut, markerAt);
    }
    if (jsonAt > 0) {
      cut = Math.min(cut, jsonAt);
    }

    if (cut > 0) {
      String segment = pending.substring(0, cut);
      if (!dropPlainPreamble
          && !GraphJsonLeakGuard.looksLikeGraphGenerateJson(segment)) {
        emitPlain(segment);
      }
      pending.delete(0, cut);
      if (jsonAt > 0 && GraphJsonLeakGuard.looksLikeGraphGenerateJson(pending)) {
        mode = Mode.JSON_BUFFER;
      }
      return true;
    }

    if (pending.length() > 400 && markerAt < 0 && jsonAt < 0) {
      if (!dropPlainPreamble && !GraphJsonLeakGuard.looksLikeGraphGenerateJson(pending)) {
        emitPlain(pending.toString());
      }
      pending.setLength(0);
      return true;
    }
    return false;
  }

  private boolean drainMarker() {
    if (activeMarker == null) {
      int markerAt = indexOfAnyMarker(pending);
      if (markerAt >= 0) {
        startMarkerAt(markerAt);
        return true;
      }
      return false;
    }
    int endAt = GraphMarkerSanitizer.indexOfEndMarker(pending);
    if (endAt < 0) {
      if (MARKER_CONTENT.equals(activeMarker) && !pending.isEmpty()) {
        // ★ Stream AGENT_CONTENT continuously (not just the first block)
        // so the user sees incremental progress during long generate phases
        emitPlain(pending.toString());
        agentContentStreamed = true;
        pending.setLength(0);
      } else if (!pending.isEmpty()) {
        markerBody.append(pending);
        pending.setLength(0);
      }
      return false;
    }
    int endLen = GraphMarkerSanitizer.endMarkerLength(pending, endAt);
    markerBody.append(pending.substring(0, endAt));
    pending.delete(0, endAt + endLen);
    closeMarker();
    mode = Mode.DETECT;
    return !pending.isEmpty();
  }

  private void startMarkerAt(int index) {
    String kind = GraphMarkerSanitizer.markerKindAt(pending, index);
    int len = GraphMarkerSanitizer.markerTokenLength(pending, index);
    if (kind == null || len <= 0 || MARKER_END.equals(kind)) {
      return;
    }
    pending.delete(0, index + len);
    activeMarker = kind;
    mode = Mode.IN_MARKER;
    markerBody.setLength(0);
  }

  private void closeMarker() {
    String body = markerBody.toString().trim();
    markerBody.setLength(0);
    String phaseId = (String) state.value("phaseCursor").orElse("");
    if (MARKER_CONTENT.equals(activeMarker)) {
      // ★ Stream AGENT_CONTENT continuously (not just the first block)
      // so the user sees incremental progress during long generate phases
      if (!body.isEmpty()) {
        emitPlain(body);
        agentContentStreamed = true;
      }
    } else if (MARKER_THINKING.equals(activeMarker)) {
      if (!body.isEmpty() && !agentThinkingEmitted) {
        GraphSseHelper.emitEvent(
            state, SseEvents.AGENT_THINKING, Map.of("text", body, "phaseId", phaseId));
        agentThinkingEmitted = true;
      }
    } else if (MARKER_WRITING.equals(activeMarker) || MARKER_READING.equals(activeMarker)) {
      // File previews and reading status are emitted via applyPatch / tool cards — not LLM prose.
    }
    activeMarker = null;
  }

  private void emitPlain(String text) {
    if (GraphJsonLeakGuard.looksLikeGraphGenerateJson(text)) {
      mode = Mode.JSON_BUFFER;
      return;
    }
    String cleaned = GraphContentSanitizer.stripForDisplay(text);
    if (!cleaned.isBlank()) {
      GraphSseHelper.emitStreamDelta(state, cleaned);
      plainTextStreamed = true;
    }
  }

  private int indexOfAnyMarker(StringBuilder s) {
    return GraphMarkerSanitizer.indexOfOpenMarker(s);
  }

  private static int leadingWhitespaceLength(StringBuilder s) {
    int i = 0;
    while (i < s.length()) {
      char c = s.charAt(i);
      if (c != ' ' && c != '\t' && c != '\n' && c != '\r') {
        break;
      }
      i++;
    }
    return i;
  }
}

package io.codepilot.core.conversation;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.dto.ModelEnvelope;
import java.util.function.Consumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Streaming JSON parser for the model envelope.
 *
 * <p>Supports two modes:
 * <ul>
 *   <li><b>parseFinal</b>: batch parsing of the complete buffered text (legacy).
 *   <li><b>IncrementalSession</b>: incremental parsing that attempts to detect and emit partial
 *       envelope fields (e.g. thought, final.answer) as they arrive chunk by chunk, without
 *       waiting for the full output.
 * </ul>
 */
@Component
public class EnvelopeStreamParser {

  private static final Logger log = LoggerFactory.getLogger(EnvelopeStreamParser.class);

  private final ObjectMapper mapper;

  public EnvelopeStreamParser(ObjectMapper mapper) {
    this.mapper = mapper;
  }

  /** Parses a complete buffered text into an envelope; returns {@code null} on parse failure. */
  public ModelEnvelope parseFinal(String buffered) {
    if (buffered == null || buffered.isBlank()) return null;
    String json = extractJsonObject(buffered);
    if (json == null) return null;
    try {
      return mapper.readValue(json, ModelEnvelope.class);
    } catch (Exception e) {
      log.debug("Envelope parse failed: {}", e.toString());
      return null;
    }
  }

  /** Returns a normalized JSON tree (used when full mapping is too brittle). */
  public JsonNode parseTree(String buffered) {
    String json = extractJsonObject(buffered);
    if (json == null) return null;
    try {
      return mapper.readTree(json);
    } catch (Exception e) {
      return null;
    }
  }

  /**
   * Creates an incremental parsing session. Feed chunks via {@code feed()} and receive partial
   * results via the callback. Call {@code finish()} to get the final envelope.
   */
  public IncrementalSession newIncrementalSession(Consumer<String> deltaCallback) {
    return new IncrementalSession(deltaCallback);
  }

  /** Extracts the first balanced JSON object from a (possibly noisy) string. */
  private String extractJsonObject(String s) {
    int start = s.indexOf('{');
    if (start < 0) return null;
    int depth = 0;
    boolean inStr = false;
    boolean esc = false;
    for (int i = start; i < s.length(); i++) {
      char c = s.charAt(i);
      if (esc) {
        esc = false;
        continue;
      }
      if (inStr) {
        if (c == '\\') esc = true;
        else if (c == '"') inStr = false;
        continue;
      }
      if (c == '"') inStr = true;
      else if (c == '{') depth++;
      else if (c == '}') {
        depth--;
        if (depth == 0) return s.substring(start, i + 1);
      }
    }
    return null;
  }

  /**
   * Incremental parsing session that buffers incoming chunks and attempts partial JSON extraction
   * at each step. Emits deltas for "thought" and "final.answer" fields as they grow.
   */
  public class IncrementalSession {
    private final StringBuilder buffer = new StringBuilder();
    private final Consumer<String> deltaCallback;
    private int lastEmittedLength = 0;

    IncrementalSession(Consumer<String> deltaCallback) {
      this.deltaCallback = deltaCallback;
    }

    /** Feed a new chunk from the model stream. */
    public void feed(String chunk) {
      if (chunk == null) return;
      buffer.append(chunk);

      // Attempt to emit incremental deltas from known text fields
      // Look for "answer": "..." or plain text accumulation
      String current = buffer.toString();
      if (current.length() > lastEmittedLength) {
        // Extract text after the last emitted position that looks like answer content
        String newPart = current.substring(lastEmittedLength);
        // Simple heuristic: if we're inside a JSON string value, emit the new chars
        if (!newPart.isBlank() && !newPart.startsWith("{") && !newPart.startsWith("\"")) {
          deltaCallback.accept(newPart);
          lastEmittedLength = current.length();
        }
      }
    }

    /** Complete the session and return the final parsed envelope. */
    public ModelEnvelope finish() {
      return parseFinal(buffer.toString());
    }

    /** Returns the full accumulated buffer. */
    public String getBuffer() {
      return buffer.toString();
    }
  }
}
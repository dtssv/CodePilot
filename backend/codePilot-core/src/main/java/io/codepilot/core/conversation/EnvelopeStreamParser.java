package io.codepilot.core.conversation;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.dto.ModelEnvelope;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Streaming JSON parser for the model envelope.
 *
 * <p>The model is instructed to emit ONE strict JSON object per turn (see {@code agent.system}
 * prompt), but token-level chunking means we don't get a complete JSON until the stream ends. This
 * helper buffers chunks and produces:
 *
 * <ul>
 *   <li>partial deltas of the {@code thought} / {@code final.answer} fields whenever they grow,
 *       which the UI can render as live text;
 *   <li>a final {@link ModelEnvelope} when the stream completes.
 * </ul>
 *
 * <p>For M4 we keep the implementation conservative: we accumulate raw text and parse the full
 * JSON at the end. {@code delta} events for incremental rendering still flow through the LLM
 * stream directly.
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
}
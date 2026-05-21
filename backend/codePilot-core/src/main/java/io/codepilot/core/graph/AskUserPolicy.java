package io.codepilot.core.graph;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Structural normalization for askUser payloads — no content keyword filtering. */
public final class AskUserPolicy {

  private AskUserPolicy() {}

  /**
   * Normalizes shape only (text key, trim). Language and wording come from LLM prompts.
   */
  /** Accepts a structured map or a plain string (legacy / escalation text). */
  public static Map<String, Object> normalizeQuestion(Object raw) {
    if (raw == null) {
      return null;
    }
    if (raw instanceof String s) {
      String text = s.trim();
      if (text.isEmpty()) {
        return null;
      }
      return Map.of("kind", "freeform", "text", text);
    }
    if (raw instanceof Map<?, ?> m) {
      @SuppressWarnings("unchecked")
      Map<String, Object> map = (Map<String, Object>) m;
      return normalizeQuestionMap(map);
    }
    return null;
  }

  public static Map<String, Object> normalizeQuestionMap(Map<String, Object> raw) {
    if (raw == null || raw.isEmpty()) {
      return null;
    }
    Map<String, Object> out = new LinkedHashMap<>(raw);
    String text = String.valueOf(out.getOrDefault("text", out.getOrDefault("question", ""))).trim();
    if (text.isEmpty()) {
      return null;
    }
    out.put("text", text);
    out.remove("question");
    return out;
  }

  public static String defaultNeedsInputTitle() {
    return "需要您的确认以继续";
  }
}

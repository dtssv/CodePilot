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

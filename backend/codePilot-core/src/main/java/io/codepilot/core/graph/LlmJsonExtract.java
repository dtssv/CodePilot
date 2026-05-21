package io.codepilot.core.graph;

/**
 * Extracts and sanitizes JSON blobs from LLM text responses (markdown fences, prose wrappers).
 */
public final class LlmJsonExtract {

  private LlmJsonExtract() {}

  public static String extractJson(String response) {
    if (response == null) {
      return "{}";
    }
    // Search for <<<GRAPH_JSON>>> in the ORIGINAL response first —
    // stripForDisplay removes all markers, making the check below impossible.
    if (response.contains(GraphStreamProcessor.MARKER_GRAPH)) {
      int start = response.indexOf(GraphStreamProcessor.MARKER_GRAPH)
          + GraphStreamProcessor.MARKER_GRAPH.length();
      int end = response.indexOf(GraphStreamProcessor.MARKER_END, start);
      String body = end > start ? response.substring(start, end).trim() : response.substring(start).trim();
      return extractJsonObject(body);
    }
    String trimmed = GraphMarkerSanitizer.stripForDisplay(response).trim();
    if (trimmed.startsWith("```")) {
      // Find the end of the opening fence line (``` or ```json etc.)
      int newlineIdx = trimmed.indexOf('\n');
      int start;
      if (newlineIdx >= 0) {
        // Normal case: ```json\n{...}\n```
        start = newlineIdx + 1;
      } else {
        // Inline case: ```json{"a":1}```  — skip the opening ``` and optional lang tag
        start = 3; // past opening ```
        // skip optional language tag (e.g. "json", "JSON") that is not part of the JSON body
        // JSON must start with '{' or '['
        int jsonStart = -1;
        for (int i = start; i < trimmed.length(); i++) {
          char c = trimmed.charAt(i);
          if (c == '{' || c == '[') {
            jsonStart = i;
            break;
          }
          // skip letters/digits of the lang tag
          if (!Character.isLetterOrDigit(c) && c != '_' && c != '-') {
            break;
          }
        }
        if (jsonStart >= 0) start = jsonStart;
      }
      int end = trimmed.lastIndexOf("```");
      // Ensure the closing ``` is different from the opening one
      if (end > 3) {
        return extractJsonObject(trimmed.substring(start, end).trim());
      }
      // No closing fence — extract from start to end of string
      return extractJsonObject(trimmed.substring(start).trim());
    }
    return extractJsonObject(trimmed);
  }

  /**
   * Escape raw control chars (U+0000–U+001F except TAB) inside JSON string values so Jackson can parse.
   */
  public static String sanitizeControlChars(String json) {
    if (json == null || json.isEmpty()) {
      return json;
    }
    StringBuilder sb = new StringBuilder(json.length());
    boolean inString = false;
    for (int i = 0; i < json.length(); i++) {
      char c = json.charAt(i);
      if (inString) {
        if (c == '\\') {
          if (i + 1 < json.length()) {
            char next = json.charAt(i + 1);
            if (isJacksonValidEscape(next)) {
              sb.append(c).append(next);
              i++;
            } else {
              sb.append(next);
              i++;
            }
          } else {
            sb.append(c);
          }
          continue;
        }
        if (c == '"') {
          inString = false;
          sb.append(c);
          continue;
        }
        if (c <= 0x1F && c != 0x09) {
          sb.append(escapeControlChar(c));
        } else {
          sb.append(c);
        }
      } else {
        if (c == '"') {
          inString = true;
        }
        sb.append(c);
      }
    }
    return sb.toString();
  }

  public static String parseableJson(String response) {
    String json = extractJson(response);
    json = stripPreJsonProse(json);
    return sanitizeControlChars(json);
  }

  /**
   * When LLM outputs mixed format (AGENT_CONTENT prose + GRAPH_JSON), the extracted JSON
   * may still have residual Markdown prose before the first {@code {}. Strip it so Jackson
   * can parse the JSON object correctly.
   */
  static String stripPreJsonProse(String text) {
    if (text == null || text.isBlank()) {
      return text;
    }
    int firstBrace = text.indexOf('{');
    if (firstBrace <= 0) {
      return text;
    }
    // Only strip if the text before { is clearly not JSON (contains letters/symbols)
    String prefix = text.substring(0, firstBrace).trim();
    if (prefix.isEmpty()) {
      return text;
    }
    // If prefix looks like prose/markdown (has non-JSON characters), strip it
    // Keep the JSON object starting from {
    if (prefix.chars().anyMatch(c -> Character.isLetter(c) && c != 'n' && c != 't'
        && c != 'r' && c != 'u' && c != 'f' && c != 'a' && c != 'e')) {
      return text.substring(firstBrace);
    }
    return text;
  }

  /** First balanced {@code {...}} object in text (skips prose before JSON). */
  static String extractJsonObject(String text) {
    if (text == null || text.isBlank()) {
      return "{}";
    }
    int start = text.indexOf('{');
    if (start < 0) {
      return "{}";
    }
    int depth = 0;
    boolean inString = false;
    for (int i = start; i < text.length(); i++) {
      char c = text.charAt(i);
      if (inString) {
        if (c == '\\' && i + 1 < text.length()) {
          i++;
          continue;
        }
        if (c == '"') {
          inString = false;
        }
        continue;
      }
      if (c == '"') {
        inString = true;
        continue;
      }
      if (c == '{') {
        depth++;
      } else if (c == '}') {
        depth--;
        if (depth == 0) {
          return text.substring(start, i + 1);
        }
      }
    }
    int braceEnd = text.lastIndexOf('}');
    if (braceEnd > start) {
      return text.substring(start, braceEnd + 1);
    }
    return text.substring(start).trim();
  }

  private static boolean isJacksonValidEscape(char ch) {
    return switch (ch) {
      case '"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u' -> true;
      default -> false;
    };
  }

  private static String escapeControlChar(char c) {
    return switch (c) {
      case '\n' -> "\\n";
      case '\r' -> "\\r";
      case '\t' -> "\\t";
      case '\b' -> "\\b";
      case '\f' -> "\\f";
      default -> String.format("\\u%04x", (int) c);
    };
  }
}

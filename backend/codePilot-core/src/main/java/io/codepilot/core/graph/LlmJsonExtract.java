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
    String trimmed = GraphMarkerSanitizer.stripForDisplay(response).trim();
    if (trimmed.contains(GraphStreamProcessor.MARKER_GRAPH)) {
      int start = trimmed.indexOf(GraphStreamProcessor.MARKER_GRAPH)
          + GraphStreamProcessor.MARKER_GRAPH.length();
      int end = trimmed.indexOf(GraphStreamProcessor.MARKER_END, start);
      String body = end > start ? trimmed.substring(start, end).trim() : trimmed.substring(start).trim();
      return extractJsonObject(body);
    }
    if (trimmed.startsWith("```")) {
      int start = trimmed.indexOf('\n') + 1;
      int end = trimmed.lastIndexOf("```");
      if (end > start) {
        return extractJsonObject(trimmed.substring(start, end).trim());
      }
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
    return sanitizeControlChars(extractJson(response));
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

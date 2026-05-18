package io.codepilot.core.graph;

/**
 * Extracts and sanitizes JSON blobs from LLM text responses (markdown fences, prose wrappers).
 */
public final class LlmJsonExtract {

  private LlmJsonExtract() {}

  public static String extractJson(String response) {
    if (response == null) return "{}";
    String trimmed = response.trim();
    if (trimmed.startsWith("```")) {
      int start = trimmed.indexOf('\n') + 1;
      int end = trimmed.lastIndexOf("```");
      if (end > start) return trimmed.substring(start, end).trim();
    }
    int braceStart = trimmed.indexOf('{');
    int braceEnd = trimmed.lastIndexOf('}');
    if (braceStart >= 0 && braceEnd > braceStart) {
      return trimmed.substring(braceStart, braceEnd + 1);
    }
    return trimmed;
  }

  /**
   * Escape raw control chars (U+0000–U+001F except TAB) inside JSON string values so Jackson can parse.
   */
  public static String sanitizeControlChars(String json) {
    if (json == null || json.isEmpty()) return json;
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
              // LLM may emit invalid escapes like \` — drop the backslash, keep the raw char
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
        if (c == '"') inString = true;
        sb.append(c);
      }
    }
    return sb.toString();
  }

  public static String parseableJson(String response) {
    return sanitizeControlChars(extractJson(response));
  }

  /**
   * Whether {@code ch} is a valid JSON escape character per RFC 8259 / Jackson.
   * Valid escapes: " \ / b f n r t u
   */
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


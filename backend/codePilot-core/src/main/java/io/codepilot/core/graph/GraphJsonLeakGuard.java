package io.codepilot.core.graph;

/** Detects graph generate JSON that must not be streamed to the user as chat prose. */
public final class GraphJsonLeakGuard {

  private GraphJsonLeakGuard() {}

  public static boolean looksLikeGraphGenerateJson(CharSequence text) {
    if (text == null) {
      return false;
    }
    String s = text.toString().trim();
    if (s.length() < 24 || !s.startsWith("{")) {
      return false;
    }
    return s.contains("\"toolCalls\"")
        || s.contains("\"thought\"")
        || s.contains("\"infoRequests\"")
        || s.contains("\"agentThinking\"")
        || s.contains("\"agentContent\"")
        || s.contains("\"textOutput\"")
        || s.contains("\"patches\"");
  }
}

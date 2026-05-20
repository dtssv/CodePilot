package io.codepilot.core.graph;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Strips graph streaming markers from user-visible text (complete or LLM-truncated forms). */
public final class GraphMarkerSanitizer {

  /** AGENT_W(?:RITING|ITING) matches common LLM typo AGENT_WITING (missing R). */
  private static final String MARKER_NAMES =
      "GRAPH_JSON|AGENT_CONTENT|AGENT_THINKING|AGENT_W(?:RITING|ITING)|AGENT_READING|END";

  /** Matches <<<GRAPH_JSON>>>, GRAPH_JSON>>>, AGENT_WRITING>>>, etc. */
  private static final Pattern MARKER_TOKEN =
      Pattern.compile(
          "(?:<<<\\s*)?(?:" + MARKER_NAMES + ")\\s*>>>?",
          Pattern.CASE_INSENSITIVE);

  /**
   * Bare / truncated markers: {@code AGENT_CONTENT>}, {@code END>}, {@code GRAPH_JSON} without
   * leading {@code <<<}.
   */
  private static final Pattern LOOSE_MARKER =
      Pattern.compile(
          "(?:<<<\\s*)?(?:" + MARKER_NAMES + ")(?:\\s*>>>+)?>?",
          Pattern.CASE_INSENSITIVE);

  /** Glued tokens with no delimiter, e.g. {@code END>AGENT_THINKING}, {@code GRAPH_JSONAGENT_CONTENT}. */
  private static final Pattern GLUED_MARKER_NAMES =
      Pattern.compile("(?:" + MARKER_NAMES + ")", Pattern.CASE_INSENSITIVE);

  private static final Pattern PARTIAL_MARKER =
      Pattern.compile("<<<(?:" + MARKER_NAMES + ")?>?$", Pattern.CASE_INSENSITIVE);

  /** Orphan angle brackets left when markers are truncated (<<>, <<<>, etc.). */
  private static final Pattern ORPHAN_BRACKETS = Pattern.compile("<<<+>?|<<>+");

  /** Lone {@code >} left after marker stripping (e.g. {@code AGENT_THINKING开始}). */
  private static final Pattern LONE_ANGLE =
      Pattern.compile("(?<=[\\p{L}\\p{N}。！？.!?])\\s*>\\s*(?=[\\p{L}\\p{N}#])");

  private GraphMarkerSanitizer() {}

  public static String stripForDisplay(String text) {
    if (text == null || text.isEmpty()) {
      return "";
    }
    String s = MARKER_TOKEN.matcher(text).replaceAll("");
    s = LOOSE_MARKER.matcher(s).replaceAll("");
    // Repeat until stable — removes GRAPH_JSON from GRAPH_JSONAGENT_CONTENT leftovers
    String prev;
    do {
      prev = s;
      s = GLUED_MARKER_NAMES.matcher(s).replaceAll("");
    } while (!s.equals(prev));
    s = ORPHAN_BRACKETS.matcher(s).replaceAll("");
    s = PARTIAL_MARKER.matcher(s).replaceAll("");
    s = LONE_ANGLE.matcher(s).replaceAll("");
    return s.trim();
  }

  /** Index of the next open marker (not END), or -1. */
  public static int indexOfOpenMarker(CharSequence text) {
    if (text == null || text.length() == 0) {
      return -1;
    }
    Matcher m = MARKER_TOKEN.matcher(text);
    while (m.find()) {
      String g = m.group().toUpperCase();
      if (!g.contains("END")) {
        return m.start();
      }
    }
    return -1;
  }

  public static int markerTokenLength(CharSequence text, int index) {
    Matcher m = MARKER_TOKEN.matcher(text);
    if (m.find(index) && m.start() == index) {
      return m.end() - m.start();
    }
    return 0;
  }

  public static String markerKindAt(CharSequence text, int index) {
    Matcher m = MARKER_TOKEN.matcher(text);
    if (!m.find(index) || m.start() != index) {
      return null;
    }
    String token = m.group().toUpperCase();
    if (token.contains("GRAPH_JSON")) {
      return GraphStreamProcessor.MARKER_GRAPH;
    }
    if (token.contains("AGENT_CONTENT")) {
      return GraphStreamProcessor.MARKER_CONTENT;
    }
    if (token.contains("AGENT_THINKING")) {
      return GraphStreamProcessor.MARKER_THINKING;
    }
    if (token.contains("AGENT_W")) {
      return GraphStreamProcessor.MARKER_WRITING;
    }
    if (token.contains("AGENT_READING")) {
      return GraphStreamProcessor.MARKER_READING;
    }
    if (token.contains("END")) {
      return GraphStreamProcessor.MARKER_END;
    }
    return null;
  }

  public static int indexOfEndMarker(CharSequence text) {
    if (text == null) {
      return -1;
    }
    Matcher m = MARKER_TOKEN.matcher(text);
    while (m.find()) {
      String g = m.group().toUpperCase();
      if (g.contains("END")) {
        return m.start();
      }
    }
    return -1;
  }

  public static int endMarkerLength(CharSequence text, int index) {
    Matcher m = MARKER_TOKEN.matcher(text);
    if (m.find(index) && m.start() == index) {
      String g = m.group().toUpperCase();
      if (g.contains("END")) {
        return m.end() - m.start();
      }
    }
    return 0;
  }
}

package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
/**
 * Tracks distinct tool strategies tried in the current plan step. After 3 unsuccessful,
 * non-duplicate approaches, {@link #isExhausted} triggers an LLM-authored user message (not
 * hardcoded copy).
 */
public final class ToolApproachTracker {

  public static final int MAX_DISTINCT_APPROACHES = 3;

  private ToolApproachTracker() {}

  @SuppressWarnings("unchecked")
  public static List<String> history(OverAllState state) {
    Object raw = state.value("toolApproachHistory").orElse(List.of());
    if (raw instanceof List<?> list) {
      List<String> out = new ArrayList<>();
      for (Object o : list) {
        if (o != null && !o.toString().isBlank()) {
          out.add(o.toString());
        }
      }
      return out;
    }
    return List.of();
  }

  public static boolean isExhausted(OverAllState state) {
    return Boolean.TRUE.equals(state.value("toolApproachExhausted").orElse(false));
  }

  /** Fingerprint for deduplication — same path/kind/query counts as one approach. */
  public static String fingerprint(String kind, Map<String, Object> args) {
    if (kind == null || kind.isBlank()) {
      return "unknown";
    }
    Map<String, Object> a = args != null ? args : Map.of();
    String path = normalizePath(a.get("path"));
    return switch (kind) {
      case "fs.list" -> {
        boolean rec = Boolean.TRUE.equals(a.get("recursive"));
        yield "fs.list:" + path + (rec ? ":recursive" : "");
      }
      case "fs.read" -> "fs.read:" + path;
      case "fs.grep" -> "fs.grep:"
          + normalizeToken(a.get("query"))
          + "@"
          + path;
      case "code.outline", "code.symbol", "code.usages" ->
          kind + ":" + path + ":" + normalizeToken(a.get("name"));
      case "shell.exec" -> "shell.exec:" + normalizeToken(a.get("command"));
      default -> kind + ":" + path;
    };
  }

  public static String fingerprintFromJson(String kind, JsonNode args) {
    if (args == null || args.isNull()) {
      return fingerprint(kind, Map.of());
    }
    Map<String, Object> map = new LinkedHashMap<>();
    args.fields()
        .forEachRemaining(
            e -> {
              JsonNode v = e.getValue();
              if (v.isTextual()) {
                map.put(e.getKey(), v.asText());
              } else if (v.isBoolean()) {
                map.put(e.getKey(), v.asBoolean());
              } else if (v.isNumber()) {
                map.put(e.getKey(), v.asLong());
              }
            });
    return fingerprint(kind, map);
  }

  /**
   * Whether a gathered entry did not meet the step's intent (empty list, empty read, failed
   * shell, etc.).
   */
  @SuppressWarnings("unchecked")
  public static boolean isUnsatisfactory(String kind, Map<String, Object> entry) {
    if (entry == null || entry.isEmpty()) {
      return true;
    }
    if (!GatheredInfoFormatter.entrySucceeded(entry)) {
      return true;
    }
    Object result = entry.get("result");
    if (!(result instanceof Map<?, ?> raw)) {
      return false;
    }
    Map<String, Object> m = (Map<String, Object>) raw;
    return switch (kind) {
      case "fs.list" -> listEntriesEmpty(m);
      case "fs.read" -> {
        Object content = m.get("content");
        yield content == null || content.toString().isBlank();
      }
      case "fs.grep" -> {
        Object hits = m.get("hits");
        if (hits instanceof List<?> list) {
          yield list.isEmpty();
        }
        yield false;
      }
      case "shell.exec" -> {
        Object exit = m.get("exitCode");
        int code = exit instanceof Number n ? n.intValue() : -1;
        yield code != 0 || Boolean.TRUE.equals(m.get("timedOut"));
      }
      default -> false;
    };
  }

  @SuppressWarnings("unchecked")
  public static boolean gatheredHasUnsatisfactory(Map<String, Object> gathered) {
    if (gathered == null || gathered.isEmpty()) {
      return false;
    }
    for (Object value : gathered.values()) {
      if (value instanceof Map<?, ?> raw) {
        Map<String, Object> entry = (Map<String, Object>) raw;
        String kind = String.valueOf(entry.getOrDefault("kind", ""));
        if (isUnsatisfactory(kind, entry)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Records unsatisfactory approaches from a gather batch (infoRequests executed on client).
   */
  @SuppressWarnings("unchecked")
  public static void recordFromRequests(
      OverAllState state,
      List<Map<String, Object>> requests,
      Map<String, Object> gathered,
      Map<String, Object> updates) {
    if (requests == null || requests.isEmpty()) {
      return;
    }
    List<Map<String, Object>> round = new ArrayList<>();
    for (Map<String, Object> req : requests) {
      String kind = String.valueOf(req.getOrDefault("kind", ""));
      if (kind.isBlank()) {
        continue;
      }
      Map<String, Object> args =
          req.get("args") instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
      String fp = fingerprint(kind, args);
      String reqId = String.valueOf(req.getOrDefault("id", ""));
      Map<String, Object> entry = findGatherEntry(gathered, reqId);
      boolean bad = entry == null || isUnsatisfactory(kind, entry);
      if (bad) {
        round.add(Map.of("fingerprint", fp, "unsatisfactory", true));
      }
    }
    mergeHistory(state, round, updates);
  }

  /** Records unsatisfactory approaches from direct toolCalls in generate. */
  public static void recordFromDirectCalls(
      OverAllState state,
      List<JsonNode> calls,
      Map<String, Object> gathered,
      Map<String, Object> updates) {
    if (calls == null || calls.isEmpty()) {
      return;
    }
    List<Map<String, Object>> round = new ArrayList<>();
    for (JsonNode tc : calls) {
      String kind = resolveToolName(tc);
      String id = tc.path("id").asText("");
      String fp = fingerprintFromJson(kind, tc.get("args"));
      Map<String, Object> entry = findGatherEntry(gathered, "direct-" + id);
      if (entry == null) {
        entry = findGatherEntry(gathered, id);
      }
      boolean bad = entry == null || isUnsatisfactory(kind, entry);
      if (bad) {
        round.add(Map.of("fingerprint", fp, "unsatisfactory", true));
      }
    }
    mergeHistory(state, round, updates);
  }

  /** Prompt block listing tried approaches and requiring a different strategy. */
  public static String promptDirective(OverAllState state) {
    List<String> history = history(state);
    if (history.isEmpty()) {
      return "";
    }
    StringBuilder sb = new StringBuilder();
    sb.append("\n\n[TOOL APPROACH — MANDATORY]\n");
    sb.append("These tool strategies were already tried and did NOT produce usable results:\n");
    for (String fp : history) {
      sb.append("- ").append(fp).append("\n");
    }
    int remaining = MAX_DISTINCT_APPROACHES - history.size();
    if (remaining > 0) {
      sb.append("You may try at most ")
          .append(remaining)
          .append(" more DISTINCT approach(es) — different kind, path, query, or command.\n");
      sb.append("Do NOT repeat any approach listed above.\n");
    } else {
      sb.append("No further tool attempts are allowed in this step. ");
      sb.append("Use textOutput to explain the situation honestly, or askUser only for a ");
      sb.append("product decision (e.g. skip step) — not for retrying the same listing/read.\n");
    }
    sb.append(
        "Examples of switching: fs.list \".\" failed → fs.grep \"leetcode\" or fs.read a known file; "
            + "empty directory → ask user to paste content or confirm the path.\n");
    return sb.toString();
  }

  public static String formatHistoryForEscalation(OverAllState state) {
    List<String> history = history(state);
    if (history.isEmpty()) {
      return "(none recorded)";
    }
    return String.join("\n", history.stream().map(h -> "- " + h).toList());
  }

  public static void clearInPhase(Map<String, Object> updates) {
    updates.put("toolApproachHistory", List.of());
    updates.put("toolApproachExhausted", false);
    updates.put("approachEscalationDone", false);
    updates.put("approachRepeatBlocked", false);
  }

  @SuppressWarnings("unchecked")
  private static void mergeHistory(
      OverAllState state, List<Map<String, Object>> round, Map<String, Object> updates) {
    if (round.isEmpty()) {
      return;
    }
    List<String> history = new ArrayList<>(history(state));
    boolean added = false;
    for (Map<String, Object> att : round) {
      if (!Boolean.TRUE.equals(att.get("unsatisfactory"))) {
        continue;
      }
      String fp = String.valueOf(att.get("fingerprint"));
      if (fp.isBlank() || history.contains(fp)) {
        continue;
      }
      history.add(fp);
      added = true;
    }
    if (!added) {
      return;
    }
    updates.put("toolApproachHistory", history);
    if (history.size() >= MAX_DISTINCT_APPROACHES) {
      updates.put("toolApproachExhausted", true);
    }
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> findGatherEntry(Map<String, Object> gathered, String id) {
    if (gathered == null || id == null || id.isBlank()) {
      return null;
    }
    Object direct = gathered.get(id);
    if (direct instanceof Map<?, ?> m) {
      return (Map<String, Object>) m;
    }
    for (Object value : gathered.values()) {
      if (value instanceof Map<?, ?> entry) {
        Map<String, Object> map = (Map<String, Object>) entry;
        if (id.equals(String.valueOf(map.get("id")))) {
          return map;
        }
      }
    }
    return null;
  }

  private static boolean listEntriesEmpty(Map<String, Object> result) {
    Object entries = result.get("entries");
    if (entries instanceof List<?> list) {
      return list.isEmpty();
    }
    return true;
  }

  private static String normalizePath(Object path) {
    if (path == null) {
      return ".";
    }
    String s = path.toString().trim();
    if (s.isEmpty() || "null".equals(s)) {
      return ".";
    }
    return s.replace('\\', '/');
  }

  private static String normalizeToken(Object value) {
    if (value == null) {
      return "";
    }
    String s = value.toString().trim();
    if (s.length() > 120) {
      return s.substring(0, 120);
    }
    return s;
  }

  private static String resolveToolName(JsonNode tc) {
    if (tc == null || tc.isNull()) {
      return "";
    }
    String name = tc.path("name").asText("").trim();
    if (!name.isEmpty()) {
      return name;
    }
    return tc.path("kind").asText("").trim();
  }
}

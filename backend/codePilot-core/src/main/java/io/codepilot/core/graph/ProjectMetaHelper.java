package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Uses plugin-provided {@code projectMeta} (root directory listing) to avoid redundant
 * {@code fs.list:.} tool rounds when the LLM repeats an already-known approach.
 */
public final class ProjectMetaHelper {

  private static final String ROOT_ENTRIES_MARKER = "Root directory entries (";
  private static final String SYNTHETIC_KEY = "project-meta-root-list";
  private static final String ROOT_LIST_FP = "fs.list:.";

  private ProjectMetaHelper() {}

  /**
   * Seeds initial graph state from {@code projectMeta} so DISCOVER steps can satisfy goals
   * without calling {@code fs.list} on {@code .} again.
   */
  @SuppressWarnings("unchecked")
  public static void seedFromProjectMeta(Map<String, Object> initial) {
    String meta = String.valueOf(initial.getOrDefault("projectMeta", "")).trim();
    if (meta.isBlank()) {
      return;
    }
    Map<String, Object> gathered =
        new LinkedHashMap<>(
            (Map<String, Object>) initial.getOrDefault("gatheredInfo", Map.of()));
    if (PhaseGoalHelper.gatheredHasSuccessfulList(gathered)) {
      return;
    }
    List<Map<String, Object>> entries = parseRootEntries(meta);
    if (entries.isEmpty()) {
      return;
    }
    gathered.put(SYNTHETIC_KEY, syntheticListEntry(entries));
    initial.put("gatheredInfo", gathered);

    List<String> attempted =
        new ArrayList<>(
            (List<String>) initial.getOrDefault("toolApproachesAttempted", List.of()));
    if (!attempted.contains(ROOT_LIST_FP)) {
      attempted.add(ROOT_LIST_FP);
      initial.put("toolApproachesAttempted", List.copyOf(attempted));
    }

    Map<String, Object> facts = SessionExecutionFacts.mergeFromGathered(null, gathered);
    if (!facts.isEmpty()) {
      initial.put(SessionExecutionFacts.STATE_KEY, facts);
    }
  }

  /**
   * When duplicate {@code fs.list:.} is blocked, absorb root listing from projectMeta into
   * gathered context (DISCOVER steps only).
   *
   * @return true if listing was absorbed into {@code updates}
   */
  @SuppressWarnings("unchecked")
  public static boolean tryAbsorbRootListing(
      OverAllState state, Map<String, Object> gathered, Map<String, Object> updates) {
    if (PhaseGoalHelper.inferStepKind(state) != PhaseGoalHelper.StepKind.DISCOVER) {
      return false;
    }
    if (PhaseGoalHelper.gatheredHasSuccessfulList(gathered)) {
      return false;
    }
    String meta = (String) state.value("projectMeta").orElse("");
    List<Map<String, Object>> entries = parseRootEntries(meta);
    if (entries.isEmpty()) {
      return false;
    }
    gathered.put(SYNTHETIC_KEY, syntheticListEntry(entries));
    updates.put("gatheredInfo", gathered);
    Map<String, Object> facts = SessionExecutionFacts.mergeFromGathered(state, gathered);
    SessionExecutionFacts.putInUpdates(updates, facts);
    ToolApproachTracker.markAttempted(state, ROOT_LIST_FP, updates);
    logAbsorb(state);
    return true;
  }

  private static void logAbsorb(OverAllState state) {
    org.slf4j.LoggerFactory.getLogger(ProjectMetaHelper.class)
        .info(
            "ProjectMetaHelper: absorbed root listing from projectMeta for session={} phase={}",
            state.value("sessionId").orElse(""),
            state.value("phaseCursor").orElse(""));
  }

  /** Visible for tests. */
  static List<Map<String, Object>> parseRootEntries(String projectMeta) {
    if (projectMeta == null || projectMeta.isBlank()) {
      return List.of();
    }
    int marker = projectMeta.indexOf(ROOT_ENTRIES_MARKER);
    if (marker < 0) {
      return List.of();
    }
    int lineStart = projectMeta.indexOf('\n', marker);
    if (lineStart < 0) {
      return List.of();
    }
    List<Map<String, Object>> entries = new ArrayList<>();
    String[] lines = projectMeta.substring(lineStart + 1).split("\n");
    for (String raw : lines) {
      if (raw.isBlank()) {
        break;
      }
      if (!raw.startsWith("  ")) {
        break;
      }
      String name = raw.substring(2).strip();
      if (name.isEmpty()) {
        continue;
      }
      boolean dir = name.endsWith("/");
      String clean = dir ? name.substring(0, name.length() - 1) : name;
      if (clean.isEmpty()) {
        continue;
      }
      Map<String, Object> ent = new LinkedHashMap<>();
      ent.put("name", clean);
      ent.put("path", clean);
      ent.put("type", dir ? "dir" : "file");
      ent.put("size", 0);
      entries.add(ent);
    }
    return entries;
  }

  private static Map<String, Object> syntheticListEntry(List<Map<String, Object>> entries) {
    Map<String, Object> entry = new HashMap<>();
    entry.put("kind", "fs.list");
    entry.put("id", SYNTHETIC_KEY);
    entry.put("ok", true);
    entry.put("result", Map.of("path", ".", "entries", entries, "source", "projectMeta"));
    return entry;
  }
}

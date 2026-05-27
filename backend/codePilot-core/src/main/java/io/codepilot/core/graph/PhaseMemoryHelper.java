package io.codepilot.core.graph;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Reads phase-scoped memory metadata from LLM-planned {@code phases[]} entries.
 * Engineering code does not infer domain tags — only normalizes defaults.
 */
public final class PhaseMemoryHelper {

  public enum LoadShardMode {
    TAGS,
    ALL,
    NONE;

    public static LoadShardMode fromPhase(Map<String, Object> phase) {
      if (phase == null || phase.isEmpty()) {
        return TAGS;
      }
      Object raw = phase.get("loadShardMode");
      if (raw == null) {
        return TAGS;
      }
      String s = raw.toString().trim().toLowerCase(Locale.ROOT);
      return switch (s) {
        case "all" -> ALL;
        case "none", "skip" -> NONE;
        default -> TAGS;
      };
    }
  }

  private PhaseMemoryHelper() {}

  /** Query tags for retrieval: explicit tags + memoryHints only (not phase id unless listed). */
  @SuppressWarnings("unchecked")
  public static List<String> queryTagsFromPhase(Map<String, Object> phase) {
    if (phase == null || phase.isEmpty()) {
      return List.of();
    }
    List<String> tags = new ArrayList<>();
    Object tagsObj = phase.get("tags");
    if (tagsObj instanceof List<?> tagList) {
      tagList.stream().map(Object::toString).forEach(tags::add);
    }
    Object hintsObj = phase.get("memoryHints");
    if (hintsObj instanceof List<?> hintList) {
      hintList.stream().map(Object::toString).forEach(tags::add);
    }
    return tags.stream()
        .filter(t -> t != null && !t.isBlank())
        .distinct()
        .toList();
  }

  @SuppressWarnings("unchecked")
  public static Map<String, Object> findPhase(List<Map<String, Object>> phases, String phaseId) {
    if (phases == null || phaseId == null || phaseId.isBlank()) {
      return Map.of();
    }
    return phases.stream()
        .filter(p -> phaseId.equals(String.valueOf(p.get("id"))))
        .findFirst()
        .orElse(Map.of());
  }

  @SuppressWarnings("unchecked")
  public static Map<String, Object> currentPhase(
      com.alibaba.cloud.ai.graph.OverAllState state) {
    String phaseId = (String) state.value("phaseCursor").orElse("");
    List<Map<String, Object>> phases =
        (List<Map<String, Object>>) state.value("phases").orElse(List.of());
    return findPhase(phases, phaseId);
  }

  /** Whether verify node should be skipped for the current phase (LLM-declared budget.skipVerify). */
  public static boolean skipVerifyForPhase(Map<String, Object> phase) {
    if (phase == null || phase.isEmpty()) {
      return false;
    }
    Object budgetObj = phase.get("budget");
    if (!(budgetObj instanceof Map<?, ?> budget)) {
      return false;
    }
    Object skip = budget.get("skipVerify");
    if (skip instanceof Boolean b) {
      return b;
    }
    return "true".equalsIgnoreCase(String.valueOf(skip));
  }

  public static boolean skipVerify(com.alibaba.cloud.ai.graph.OverAllState state) {
    return skipVerifyForPhase(currentPhase(state));
  }

  /** Fill missing phase metadata defaults without changing planner structure. */
  public static Map<String, Object> withDefaults(Map<String, Object> phase) {
    Map<String, Object> out = new LinkedHashMap<>(phase);
    if (!out.containsKey("tags")) {
      out.put("tags", List.of());
    }
    if (!out.containsKey("memoryHints")) {
      out.put("memoryHints", List.of());
    }
    if (!out.containsKey("loadShardMode")) {
      out.put("loadShardMode", "tags");
    }
    Object budgetObj = out.get("budget");
    if (!(budgetObj instanceof Map<?, ?>)) {
      out.put("budget", new LinkedHashMap<>(Map.of("attempts", 3)));
    }
    return out;
  }

  /**
   * Structured product dependency: {@code requiredProducts: [{product, patterns[], searchPaths[]}]}.
   * Legacy: {@code requiredProducts: ["entity"]} + top-level productPatterns / productSearchPaths.
   */
  @SuppressWarnings("unchecked")
  public static List<ProductRequirement> productRequirements(Map<String, Object> phase) {
    if (phase == null) {
      return List.of();
    }
    Object raw = phase.get("requiredProducts");
    if (!(raw instanceof List<?> list) || list.isEmpty()) {
      return List.of();
    }
    List<ProductRequirement> out = new ArrayList<>();
    List<String> legacyPatterns =
        rawList(phase.get("productPatterns"));
    List<String> legacySearchPaths =
        rawList(phase.get("productSearchPaths"));

    for (Object item : list) {
      if (item instanceof Map<?, ?> map) {
        @SuppressWarnings("unchecked")
        Map<String, Object> m = (Map<String, Object>) map;
        String product = String.valueOf(m.getOrDefault("product", m.getOrDefault("name", "")));
        if (product.isBlank()) {
          continue;
        }
        List<String> patterns = rawList(m.get("patterns"));
        if (patterns.isEmpty()) {
          patterns = legacyPatterns;
        }
        List<String> searchPaths = rawList(m.get("searchPaths"));
        if (searchPaths.isEmpty()) {
          searchPaths = legacySearchPaths;
        }
        out.add(new ProductRequirement(product, patterns, searchPaths));
      } else {
        String product = item.toString();
        if (!product.isBlank()) {
          out.add(new ProductRequirement(product, legacyPatterns, legacySearchPaths));
        }
      }
    }
    return out;
  }

  @SuppressWarnings("unchecked")
  private static List<String> rawList(Object obj) {
    if (!(obj instanceof List<?> list)) {
      return List.of();
    }
    return list.stream().map(Object::toString).filter(s -> !s.isBlank()).toList();
  }

  public record ProductRequirement(String product, List<String> patterns, List<String> searchPaths) {}
}

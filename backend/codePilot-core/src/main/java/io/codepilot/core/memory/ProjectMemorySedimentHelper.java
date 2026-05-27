package io.codepilot.core.memory;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Normalizes graph memory candidates for persistence in {@link ProjectMemoryStore}.
 */
public final class ProjectMemorySedimentHelper {

  private ProjectMemorySedimentHelper() {}

  /**
   * Candidates approved for auto-sedimentation: IMMORTAL/PROTECTED only, promoted to LONG_TERM
   * for project store, deduped by id.
   */
  public static List<StructuredMemory> forProjectPersistence(List<Map<String, Object>> candidateMaps) {
    if (candidateMaps == null || candidateMaps.isEmpty()) {
      return List.of();
    }
    Map<String, StructuredMemory> byId = new LinkedHashMap<>();
    for (Map<String, Object> m : candidateMaps) {
      StructuredMemory memory = StructuredMemory.fromMap(m);
      if (memory.protection() != ProtectionLevel.IMMORTAL
          && memory.protection() != ProtectionLevel.PROTECTED) {
        continue;
      }
      StructuredMemory longTerm =
          new StructuredMemory(
              memory.id(),
              MemoryLayer.LONG_TERM,
              memory.protection(),
              memory.type(),
              memory.summary(),
              memory.detail(),
              memory.tags(),
              memory.createdAt(),
              System.currentTimeMillis(),
              memory.sourcePhaseId());
      byId.put(longTerm.id(), longTerm);
    }
    return new ArrayList<>(byId.values());
  }
}

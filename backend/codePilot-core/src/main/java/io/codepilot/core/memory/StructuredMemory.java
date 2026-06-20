package io.codepilot.core.memory;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Structured memory entity — replaces raw {@code Map<String, String>} conversation
 * history with a typed, protection-aware, traceable memory object.
 *
 * <p>Each memory has:
 * <ul>
 *   <li>A {@link MemoryLayer} defining its lifecycle and persistence strategy</li>
 *   <li>A {@link ProtectionLevel} controlling compression/eviction behavior</li>
 *   <li>A {@link MemoryType} categorizing its content for semantic retrieval</li>
 *   <li>A summary (always retained) and detail (retained based on protection level)</li>
 *   <li>Tags for semantic matching and a sourcePhaseId for lineage tracing</li>
 * </ul>
 *
 * <p>This record is stored in graph state as {@code activeMemories},
 * {@code shortTermMemories}, etc. and serialized to Redis for long-term persistence.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record StructuredMemory(
    /** Unique identifier for this memory entry. */
    String id,
    /** Which memory layer this belongs to. */
    MemoryLayer layer,
    /** Protection level — controls compression/eviction behavior. */
    ProtectionLevel protection,
    /** Content type — used for semantic retrieval and conflict detection. */
    MemoryType type,
    /** 1-2 sentence summary — always retained regardless of protection level. */
    String summary,
    /** Full content — retained for IMMORTAL/PROTECTED, dropped for DEGRADABLE/VOLATILE under pressure. */
    String detail,
    /** Semantic tags for retrieval matching (e.g., ["database", "mysql", "schema"]). */
    List<String> tags,
    /** Creation timestamp (epoch millis). */
    long createdAt,
    /** Last update timestamp (epoch millis). */
    long updatedAt,
    /** Which phase produced this memory — for change lineage tracing. */
    String sourcePhaseId
) {

    /** Convenience factory for creating a new memory with auto-generated ID and timestamps. */
    public static StructuredMemory of(
            MemoryLayer layer,
            ProtectionLevel protection,
            MemoryType type,
            String summary,
            String detail,
            List<String> tags,
            String sourcePhaseId) {
        long now = System.currentTimeMillis();
        return new StructuredMemory(
                UUID.randomUUID().toString(),
                layer, protection, type,
                summary, detail, tags,
                now, now, sourcePhaseId);
    }

    /** Create a copy with updated timestamp. */
    public StructuredMemory withUpdatedDetail(String newDetail) {
        return new StructuredMemory(
                id, layer, protection, type,
                summary, newDetail, tags,
                createdAt, System.currentTimeMillis(), sourcePhaseId);
    }

    /** Create a copy with protection level upgraded (never downgraded automatically). */
    public StructuredMemory withProtection(ProtectionLevel newProtection) {
        if (newProtection.ordinal() < this.protection.ordinal()) {
            // Allow upgrade only (IMMORTAL=0 is highest protection)
            return new StructuredMemory(
                    id, layer, newProtection, type,
                    summary, detail, tags,
                    createdAt, System.currentTimeMillis(), sourcePhaseId);
        }
        return this;
    }

    /** Mark this memory as superseded by another decision. */
    public StructuredMemory superseded() {
        return new StructuredMemory(
                id, layer, protection, type,
                "[SUPERSEDED] " + summary, detail, tags,
                createdAt, System.currentTimeMillis(), sourcePhaseId);
    }

    /** Convert to a map for storage in graph state (avoids Jackson serialization issues). */
    public Map<String, Object> toMap() {
        return Map.ofEntries(
                Map.entry("id", id),
                Map.entry("layer", layer.name()),
                Map.entry("protection", protection.name()),
                Map.entry("type", type.name()),
                Map.entry("summary", summary),
                Map.entry("detail", detail != null ? detail : ""),
                Map.entry("tags", tags != null ? tags : List.of()),
                Map.entry("createdAt", createdAt),
                Map.entry("updatedAt", updatedAt),
                Map.entry("sourcePhaseId", sourcePhaseId != null ? sourcePhaseId : ""));
    }

    /** Reconstruct from a map (e.g., from graph state or Redis). */
    @SuppressWarnings("unchecked")
    public static StructuredMemory fromMap(Map<String, Object> map) {
        return new StructuredMemory(
                (String) map.getOrDefault("id", UUID.randomUUID().toString()),
                MemoryLayer.valueOf((String) map.getOrDefault("layer", "INSTANTANEOUS")),
                ProtectionLevel.valueOf((String) map.getOrDefault("protection", "DEGRADABLE")),
                MemoryType.valueOf((String) map.getOrDefault("type", "FACT")),
                (String) map.getOrDefault("summary", ""),
                (String) map.getOrDefault("detail", ""),
                (List<String>) map.getOrDefault("tags", List.of()),
                ((Number) map.getOrDefault("createdAt", System.currentTimeMillis())).longValue(),
                ((Number) map.getOrDefault("updatedAt", System.currentTimeMillis())).longValue(),
                (String) map.getOrDefault("sourcePhaseId", ""));
    }
}
package io.codepilot.core.memory;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * Represents a detected anomaly in the memory system — a conflict, gap,
 * or logical inconsistency between memory entries.
 *
 * <p>Anomalies are produced by {@link MemoryConsistencyValidator} and injected
 * into graph state as {@code memoryAnomalies} so that downstream nodes
 * (generate, repair, askUser) can resolve them.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record MemoryAnomaly(
    /** Unique identifier for this anomaly. */
    String id,
    /** The type of anomaly detected. */
    AnomalyKind kind,
    /** The entity or topic involved (e.g., "database.type", "api.user-endpoint"). */
    String entity,
    /** Human-readable description of the anomaly. */
    String description,
    /** IDs of the conflicting/related memory entries. */
    List<String> relatedMemoryIds,
    /** Suggested resolution action. */
    String resolutionHint
) {

    /** Kinds of memory anomalies. */
    public enum AnomalyKind {
        /** Factual contradiction: same entity has conflicting attribute values. */
        CONFLICT,
        /** Missing critical information: entity lacks required attributes. */
        INCOMPLETE,
        /** Logical gap: a decision references an unrecorded prerequisite. */
        ORPHAN,
        /** Temporal conflict: new decision overrides old one without deprecation marker. */
        SUPERSEDED_UNMARKED
    }

    /** Factory for creating a conflict anomaly. */
    public static MemoryAnomaly conflict(String entity, String description,
                                          List<String> relatedIds, String hint) {
        return new MemoryAnomaly(
                java.util.UUID.randomUUID().toString(),
                AnomalyKind.CONFLICT, entity, description, relatedIds, hint);
    }

    /** Factory for creating an incomplete anomaly. */
    public static MemoryAnomaly incomplete(String entity, String description,
                                            List<String> relatedIds, String hint) {
        return new MemoryAnomaly(
                java.util.UUID.randomUUID().toString(),
                AnomalyKind.INCOMPLETE, entity, description, relatedIds, hint);
    }

    /** Factory for creating an orphan anomaly. */
    public static MemoryAnomaly orphan(String entity, String description,
                                        List<String> relatedIds, String hint) {
        return new MemoryAnomaly(
                java.util.UUID.randomUUID().toString(),
                AnomalyKind.ORPHAN, entity, description, relatedIds, hint);
    }

    /** Factory for creating a superseded-unmarked anomaly. */
    public static MemoryAnomaly supersededUnmarked(String entity, String description,
                                                     List<String> relatedIds, String hint) {
        return new MemoryAnomaly(
                java.util.UUID.randomUUID().toString(),
                AnomalyKind.SUPERSEDED_UNMARKED, entity, description, relatedIds, hint);
    }

    /**
     * Render as a prompt directive that the LLM can see and act on.
     * Example: "[CONFLICT] database.type: MySQL vs PostgreSQL — please clarify which is correct."
     */
    public String toPromptDirective() {
        String kindLabel = switch (kind) {
            case CONFLICT -> "CONFLICT";
            case INCOMPLETE -> "INCOMPLETE";
            case ORPHAN -> "ORPHAN";
            case SUPERSEDED_UNMARKED -> "SUPERSEDED_UNMARKED";
        };
        StringBuilder sb = new StringBuilder();
        sb.append("[").append(kindLabel).append("] ");
        if (entity != null && !entity.isBlank()) {
            sb.append(entity).append(": ");
        }
        sb.append(description);
        if (resolutionHint != null && !resolutionHint.isBlank()) {
            sb.append(" — ").append(resolutionHint);
        }
        return sb.toString();
    }
}
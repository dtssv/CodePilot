package io.codepilot.core.memory;

/**
 * Categorization of memory content type.
 *
 * <p>Used for semantic retrieval and consistency validation:
 * different types have different conflict-detection rules.
 * For example, two {@link #DECISION} memories about the same entity
 * with contradictory values trigger a conflict alert.
 */
public enum MemoryType {
    /** A design or architectural decision made during the session. */
    DECISION,
    /** Architecture-level knowledge: component relationships, tech stack choices. */
    ARCHITECTURE,
    /** API/interface contract: endpoint definitions, data schemas. */
    API_CONTRACT,
    /** A bug fix or workaround record. */
    BUG_FIX,
    /** User preference or convention (e.g., "use pytest, not unittest"). */
    PREFERENCE,
    /** A factual observation (e.g., "project uses Gradle"). */
    FACT
}
package io.codepilot.core.memory;

/**
 * Memory protection level — controls compression and eviction behavior.
 *
 * <p>Core business assets (table structures, architecture decisions, API contracts)
 * are marked {@link #IMMORTAL} and are never compressed or discarded.
 * Lower-priority information can be degraded or discarded under context pressure.
 *
 * <p>This replaces the previous FIFO eviction in ContextBudgeter with a
 * priority-aware approach.
 */
public enum ProtectionLevel {
    /** Never compressed, never discarded: table structures, architecture, business rules, API contracts. */
    IMMORTAL,
    /** Compress to summary only: key decisions, user preferences, bug-fix records. */
    PROTECTED,
    /** Can be degraded to summary: conversation flow, tool execution details. */
    DEGRADABLE,
    /** Can be discarded: chitchat, confirmations, duplicate information. */
    VOLATILE
}
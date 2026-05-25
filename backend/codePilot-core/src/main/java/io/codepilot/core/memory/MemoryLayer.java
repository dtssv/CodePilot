package io.codepilot.core.memory;

/**
 * Four-layer memory architecture.
 *
 * <p>Each layer has different lifecycle, persistence, and loading strategies:
 * <ul>
 *   <li>{@link #INSTANTANEOUS} — per-turn conversation history, rebuilt every run</li>
 *   <li>{@link #SHORT_TERM} — per-session working memory, persisted in sessionDigest</li>
 *   <li>{@link #LONG_TERM} — per-project knowledge, persisted in Redis</li>
 *   <li>{@link #GLOBAL} — cross-project rules and patterns, managed by PromptRegistry</li>
 * </ul>
 */
public enum MemoryLayer {
    /** Per-turn conversation history. Rebuilt from contexts.recent every run. */
    INSTANTANEOUS,
    /** Per-session working memory. Persisted via sessionDigest / summaryForNextTurn. */
    SHORT_TERM,
    /** Per-project knowledge. Persisted in Redis (ProjectMemoryStore). */
    LONG_TERM,
    /** Cross-project rules and patterns. Managed by PromptRegistry + .codepilot/rules/. */
    GLOBAL
}
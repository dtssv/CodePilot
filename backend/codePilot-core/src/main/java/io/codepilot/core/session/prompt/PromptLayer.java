package io.codepilot.core.session.prompt;

/**
 * Interface for a single layer in the system prompt.
 *
 * <p>Each layer contributes a section of the system prompt that gets concatenated in priority order
 * (lower = earlier in the prompt).
 *
 * <p>Layered prompt construction in {@code session/system.ts} and {@code
 * session/prompt.ts}.
 */
public interface PromptLayer {
  /**
   * Build this layer's contribution to the system prompt.
   *
   * @param ctx the prompt build context
   * @return the text for this layer
   */
  String build(PromptContext ctx);

  /**
   * Priority of this layer. Lower values appear earlier in the prompt.
   *
   * <p>Order: Identity (0) → Environment (10) → Tools (20) → Context (30) → Memory (40) → Rules
   * (50) → Output (60)
   */
  int priority();
}

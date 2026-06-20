package io.codepilot.core.session.context;

import io.codepilot.core.session.Message;
import java.util.List;

/**
 * Token budget calculator for context management.
 *
 * <p>
 *
 * <ul>
 *   <li>Total context = model's max context window
 *   <li>System prompt overhead = reserved tokens for system prompt + tools
 *   <li>Overhead reserve = safety margin (typically 10%)
 *   <li>Usable = total - system prompt - overhead reserve
 * </ul>
 */
public class ContextBudget {

  private final int maxContextTokens;
  private final int systemPromptReserve;
  private final double overheadReserveRatio;

  /** Compaction trigger thresholds (20%/45%/70%). */
  private static final double[] COMPACTION_THRESHOLDS = {0.20, 0.45, 0.70};

  public ContextBudget(int maxContextTokens) {
    this(maxContextTokens, 4096, 0.10);
  }

  public ContextBudget(int maxContextTokens, int systemPromptReserve, double overheadReserveRatio) {
    this.maxContextTokens = maxContextTokens;
    this.systemPromptReserve = systemPromptReserve;
    this.overheadReserveRatio = overheadReserveRatio;
  }

  public int maxContextTokens() {
    return maxContextTokens;
  }

  /** Tokens available for conversation messages (after system prompt and overhead). */
  public int usableTokens() {
    int overhead = (int) (maxContextTokens * overheadReserveRatio);
    return maxContextTokens - systemPromptReserve - overhead;
  }

  /** Estimate total tokens used by a list of messages. */
  public int estimateTokens(List<Message> messages) {
    int total = 0;
    for (Message msg : messages) {
      total += estimateMessageTokens(msg);
    }
    return total;
  }

  /** Rough token estimation: ~4 chars per token. */
  private int estimateMessageTokens(Message msg) {
    int chars = 0;
    if (msg.content() != null) chars += msg.content().length();
    if (msg.toolCalls() != null) {
      for (var tc : msg.toolCalls()) {
        chars += tc.name().length();
        if (tc.args() != null) chars += tc.args().toString().length();
      }
    }
    return chars / 4 + 20; // +20 for message overhead
  }

  /**
   * Check if compaction should be triggered and return the checkpoint level.
   *
   * @param estimatedTokens current token usage
   * @return 0 = no compaction, 1 = light (20%), 2 = medium (45%), 3 = heavy (70%)
   */
  public int compactionLevel(int estimatedTokens) {
    double ratio = (double) estimatedTokens / usableTokens();
    if (ratio >= COMPACTION_THRESHOLDS[2]) return 3;
    if (ratio >= COMPACTION_THRESHOLDS[1]) return 2;
    if (ratio >= COMPACTION_THRESHOLDS[0]) return 1;
    return 0;
  }

  /** Whether compaction should be triggered at all (>=20%). */
  public boolean shouldCompact(int estimatedTokens) {
    return compactionLevel(estimatedTokens) > 0;
  }
}

package io.codepilot.core.context;

import com.knuddels.jtokkit.Encodings;
import com.knuddels.jtokkit.api.Encoding;
import com.knuddels.jtokkit.api.EncodingRegistry;
import com.knuddels.jtokkit.api.EncodingType;
import org.springframework.stereotype.Component;

/**
 * Unified token counter shared by the budgeter and the compact-trigger logic.
 *
 * <p>Uses jtokkit with the cl100k_base encoding — a safe default for OpenAI-compatible models and a
 * reasonable proxy for others (the value is always a conservative upper bound in practice).
 */
@Component
public class TokenMeter {

  private final Encoding encoding;

  public TokenMeter() {
    EncodingRegistry registry = Encodings.newDefaultEncodingRegistry();
    this.encoding = registry.getEncoding(EncodingType.CL100K_BASE);
  }

  public int count(String s) {
    if (s == null || s.isEmpty()) return 0;
    return encoding.countTokens(s);
  }

  /** Returns {@code true} when {@code text} fits in {@code budget} tokens. */
  public boolean fits(String text, int budget) {
    return count(text) <= budget;
  }
}

package io.codepilot.core.session.result;

import io.codepilot.core.safety.RedactionService;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * Cleans raw tool output before it is injected back into the conversation context ("结果清洗" / result
 * cleaning).
 *
 * <p>The pipeline, in order:
 *
 * <ol>
 *   <li><b>Normalize</b> — unify line endings, trim trailing whitespace, collapse long runs of
 *       blank lines that bloat the context without adding signal.
 *   <li><b>Redact</b> — strip credentials / PII via {@link RedactionService} so secrets never reach
 *       the model or persisted history.
 *   <li><b>De-leak</b> — remove any internal tool-call / system markers a tool might echo back,
 *       which could otherwise confuse the parser or leak prompt structure.
 *   <li><b>Truncate</b> — bound the output to a character budget, keeping a head and a tail with an
 *       explicit elision notice so the model knows content was dropped.
 * </ol>
 *
 * <p>This runs for every tool result (LOCAL and REMOTE) so that oversized file dumps, noisy shell
 * logs, and accidental secrets are contained before they consume the context window.
 */
@Service
public class ToolResultSanitizer {

  private static final Pattern CRLF = Pattern.compile("\\r\\n?");
  private static final Pattern TRAILING_WS = Pattern.compile("[ \\t]+(?=\\n)");
  private static final Pattern EXCESS_BLANKS = Pattern.compile("\\n{4,}");

  /** Internal markers that must never round-trip from tool output back into context. */
  private static final Pattern INTERNAL_MARKERS =
      Pattern.compile("(?im)^\\s*```tool_call\\s*$|<context_rebuild[^>]*>|</context_rebuild>");

  private final RedactionService redaction;
  private final int maxChars;

  public ToolResultSanitizer(
      RedactionService redaction,
      @Value("${codepilot.tools.result-max-chars:8000}") int maxChars) {
    this.redaction = redaction;
    this.maxChars = maxChars;
  }

  /** Sanitize tool output using the configured default budget. */
  public Result sanitize(String toolName, String rawOutput) {
    return sanitize(toolName, rawOutput, maxChars);
  }

  /** Sanitize tool output, bounding it to {@code budget} characters. */
  public Result sanitize(String toolName, String rawOutput, int budget) {
    if (rawOutput == null || rawOutput.isEmpty()) {
      return new Result("", false, 0);
    }
    int originalLength = rawOutput.length();

    String text = CRLF.matcher(rawOutput).replaceAll("\n");
    text = TRAILING_WS.matcher(text).replaceAll("");
    text = EXCESS_BLANKS.matcher(text).replaceAll("\n\n\n");
    text = redaction.redact(text);
    text = INTERNAL_MARKERS.matcher(text).replaceAll("[stripped-marker]");
    text = text.strip();

    boolean truncated = false;
    if (budget > 0 && text.length() > budget) {
      truncated = true;
      int headLen = (int) (budget * 0.7);
      int tailLen = budget - headLen;
      String head = text.substring(0, headLen);
      String tail = text.substring(text.length() - tailLen);
      int omitted = text.length() - headLen - tailLen;
      text =
          head
              + "\n\n... ["
              + omitted
              + " characters elided by result cleaning; "
              + "use a more specific query or read a smaller range] ...\n\n"
              + tail;
    }

    return new Result(text, truncated, originalLength);
  }

  /**
   * Cleaned tool output.
   *
   * @param content the sanitized text safe to inject into context
   * @param truncated whether the output was shortened to fit the budget
   * @param originalLength length of the raw output before cleaning
   */
  public record Result(String content, boolean truncated, int originalLength) {}
}

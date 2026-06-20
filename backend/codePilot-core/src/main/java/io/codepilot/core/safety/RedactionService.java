package io.codepilot.core.safety;

import java.util.List;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/**
 * Best-effort PII / credential redaction. Operates on free text only — DO NOT pass code blocks
 * through this service: signal/style of the original code must be preserved upstream.
 *
 * <p>Order matters; rules are applied left-to-right and short-circuit at the first match for a
 * given span.
 */
@Service
public class RedactionService {

  /** A single named rule. {@code replacement} may use ${1}/${2} for groups. */
  public record Rule(String name, Pattern pattern, String replacement) {}

  private static final List<Rule> RULES =
      List.of(
          // Private key blocks (PEM format)
          new Rule(
              "private-key",
              Pattern.compile(
                  "-----BEGIN\\s+(RSA\\s+)?PRIVATE\\s+KEY-----[\\s\\S]*?-----END\\s+(RSA\\s+)?PRIVATE\\s+KEY-----"),
              "[REDACTED_PRIVATE_KEY]"),
          // OpenAI / generic Bearer
          new Rule(
              "api-key-bearer",
              Pattern.compile("(?i)bearer\\s+([A-Za-z0-9._\\-]{20,})"),
              "Bearer [REDACTED_API_KEY]"),
          // sk- / pk- style keys (OpenAI, Stripe etc.)
          new Rule(
              "sk-style", Pattern.compile("\\b([sp]k-[A-Za-z0-9]{20,})\\b"), "[REDACTED_API_KEY]"),
          // AWS Access Key Id
          new Rule(
              "aws-access-key",
              Pattern.compile("\\b(AKIA|ASIA)[0-9A-Z]{16}\\b"),
              "[REDACTED_API_KEY]"),
          // Generic API key patterns (key=xxx, apikey=xxx)
          new Rule(
              "api-key-generic",
              Pattern.compile(
                  "(?i)(api[_-]?key|secret[_-]?key)\\s*[=:]\\s*[\"']?([A-Za-z0-9+/=._\\-]{20,})[\"']?"),
              "$1=[REDACTED_API_KEY]"),
          // JWT tokens (3-part base64)
          new Rule(
              "jwt-token",
              Pattern.compile("eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}"),
              "[REDACTED_JWT]"),
          // Email
          new Rule(
              "email",
              Pattern.compile("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"),
              "***@***"),
          // Phone (CN / 北美最常见)
          new Rule("phone-cn", Pattern.compile("(?<![0-9])(1[3-9]\\d{9})(?![0-9])"), "***"),
          new Rule(
              "phone-us",
              Pattern.compile(
                  "\\b\\+?\\d{1,2}[ \\-.]?\\(?\\d{3}\\)?[ \\-.]?\\d{3}[ \\-.]?\\d{4}\\b"),
              "***"),
          // 18-digit Chinese ID (very loose — only when surrounded by non-digits)
          new Rule(
              "id-card-cn", Pattern.compile("(?<![0-9])([1-9]\\d{16}[\\dXx])(?![0-9])"), "***"),
          // Long base64 / hex secrets (>= 32 chars)
          new Rule(
              "secret-blob",
              Pattern.compile(
                  "(?i)(secret|token|password)\\s*[=:]\\s*([\"']?)([A-Za-z0-9+/=._\\-]{20,})\\2"),
              "$1=***"));

  /** Returns the redacted version of {@code text}; never returns {@code null}. */
  public String redact(String text) {
    if (text == null || text.isEmpty()) {
      return text == null ? "" : text;
    }
    String out = text;
    for (Rule rule : RULES) {
      out = rule.pattern().matcher(out).replaceAll(rule.replacement());
    }
    return out;
  }
}

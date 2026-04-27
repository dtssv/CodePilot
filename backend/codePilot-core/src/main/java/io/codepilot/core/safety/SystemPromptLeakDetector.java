package io.codepilot.core.safety;

import java.util.Base64;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/**
 * Detects "leak my system prompt" intents in user input. The detector decodes a few common
 * obfuscation layers (base64, hex, ROT13, zero-width characters) before applying its regex set,
 * so naive evasions are caught.
 *
 * <p>This service is intentionally small and side-effect free — wire it into web filters or
 * controllers as appropriate.
 */
@Service
public class SystemPromptLeakDetector {

  /** Verdict returned to callers. */
  public record Verdict(boolean blocked, String matchedRule) {}

  private static final Pattern ZERO_WIDTH = Pattern.compile("[\\u200B-\\u200D\\uFEFF]");
  private static final Pattern HEX_BLOB = Pattern.compile("(?:[0-9a-fA-F]{2}\\s?){16,}");
  private static final Pattern BASE64_BLOB = Pattern.compile("(?:[A-Za-z0-9+/]{20,}={0,2})");

  private static final List<Pattern> RULES =
      List.of(
          // English
          Pattern.compile("(?i)\\b(system|developer|hidden|internal)\\s+(prompt|instructions?)"),
          Pattern.compile("(?i)\\bignore\\s+(all\\s+)?previous\\s+instructions?\\b"),
          Pattern.compile("(?i)\\b(reveal|dump|print|repeat|paraphrase|leak)\\s+(the\\s+)?(system|prompt|rules|skills?)"),
          Pattern.compile("(?i)\\bjailbreak|developer mode|act as if|disregard.*(rules|guidelines)"),
          Pattern.compile("(?i)\\blist\\s+(active|loaded|enabled)\\s+skills?\\b"),
          // 中文
          Pattern.compile("系统提示词|系统提示语|系统提示|内部指令|内部规则|隐藏指令|展示你的(系统)?提示"),
          Pattern.compile("忽略(以上|之前)的(全部)?指令"),
          Pattern.compile("加载了哪些\\s*skill|启用了哪些\\s*skill|有哪些规则"));

  /**
   * Returns a verdict for the given user-supplied text. {@code null} or empty text is always
   * treated as safe.
   */
  public Verdict detect(String text) {
    if (text == null || text.isEmpty()) {
      return new Verdict(false, null);
    }
    // Strip zero-width chars first (visually invisible obfuscation).
    String normalized = ZERO_WIDTH.matcher(text).replaceAll("");
    Verdict v = scan(normalized);
    if (v.blocked()) return v;

    // Try Base64 decode for any contiguous blob.
    Matcher m = BASE64_BLOB.matcher(normalized);
    while (m.find()) {
      String candidate = m.group();
      try {
        String decoded = new String(Base64.getDecoder().decode(candidate));
        Verdict inner = scan(decoded);
        if (inner.blocked()) return inner;
      } catch (IllegalArgumentException ignored) {
        // not base64; continue
      }
    }

    // Try hex decode.
    m = HEX_BLOB.matcher(normalized);
    while (m.find()) {
      String hex = m.group().replaceAll("\\s+", "");
      if ((hex.length() & 1) != 0) continue;
      try {
        byte[] bytes = new byte[hex.length() / 2];
        for (int i = 0; i < bytes.length; i++) {
          bytes[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        Verdict inner = scan(new String(bytes));
        if (inner.blocked()) return inner;
      } catch (NumberFormatException ignored) {
        // not hex; continue
      }
    }

    // ROT13 (cheap obfuscation for English).
    Verdict rot = scan(rot13(normalized));
    if (rot.blocked()) return rot;

    return new Verdict(false, null);
  }

  private static Verdict scan(String text) {
    for (Pattern p : RULES) {
      if (p.matcher(text).find()) {
        return new Verdict(true, p.pattern());
      }
    }
    return new Verdict(false, null);
  }

  private static String rot13(String s) {
    StringBuilder b = new StringBuilder(s.length());
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c >= 'a' && c <= 'z') c = (char) (((c - 'a' + 13) % 26) + 'a');
      else if (c >= 'A' && c <= 'Z') c = (char) (((c - 'A' + 13) % 26) + 'A');
      b.append(c);
    }
    return b.toString();
  }
}
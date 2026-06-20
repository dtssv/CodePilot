package io.codepilot.core.session.recovery;

import io.codepilot.core.session.Message;
import java.util.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Detects doom-loop (infinite loop) behavior in the agent's conversation. */
public class DoomLoopDetector {
  private static final Logger log = LoggerFactory.getLogger(DoomLoopDetector.class);

  private final int maxRecurrence;
  private final int lookbackWindow;

  /**
   * Maximum number of times the same tool NAME (ignoring arguments) may appear in the lookback
   * window. When the agent calls fs.read with different paths 8+ times in 12 messages, it is
   * exploring aimlessly — a higher-level doom loop.
   */
  private final int maxToolCategoryRecurrence;

  /** Result of a doom-loop detection check, carrying diagnostic details for recovery. */
  public record DoomLoopResult(boolean detected, String toolName, int count, int window) {
    public static DoomLoopResult none() {
      return new DoomLoopResult(false, "", 0, 0);
    }
  }

  public DoomLoopDetector(int maxRecurrence, int lookbackWindow) {
    this(maxRecurrence, lookbackWindow, 8);
  }

  public DoomLoopDetector(int maxRecurrence, int lookbackWindow, int maxToolCategoryRecurrence) {
    this.maxRecurrence = maxRecurrence;
    this.lookbackWindow = lookbackWindow;
    this.maxToolCategoryRecurrence = maxToolCategoryRecurrence;
  }

  /**
   * Checks whether the given messages exhibit a doom-loop pattern. Returns true if any conversation
   * snippet has repeated too many times within the lookback window.
   */
  public boolean doomLoop(List<Message> history) {
    return detect(history).detected();
  }

  /**
   * Checks whether the given messages exhibit a doom-loop pattern and returns a result
   * with diagnostic details (which tool, how many times) for targeted recovery.
   */
  public DoomLoopResult detect(List<Message> history) {
    if (history.isEmpty()) return DoomLoopResult.none();

    int len = Math.min(lookbackWindow, history.size());
    List<Message> recent = history.subList(history.size() - len, history.size());

    // Build fingerprints of messages
    Map<String, Integer> fingerprintCounts = new HashMap<>();
    for (Message msg : recent) {
      String key = fingerprint(msg);
      if (key.isEmpty()) continue;
      fingerprintCounts.merge(key, 1, Integer::sum);
    }

    // If any message fingerprint appears more than maxRecurrence times
    for (var entry : fingerprintCounts.entrySet()) {
      if (entry.getValue() >= maxRecurrence) {
        log.info("Doom-loop detected: fingerprint {} appeared {} times in last {} messages",
            entry.getKey(), entry.getValue(), len);
        // Extract the tool name from the fingerprint (format: "tool_calls:name|hash,...,")
        String toolName = entry.getKey();
        if (toolName.startsWith("tool_calls:")) {
          toolName = toolName.substring("tool_calls:".length()).replaceAll(",$", "");
          // Strip args fingerprints: "name|hash" → "name"
          toolName = toolName.replaceAll("\\|[^,]*", "");
        }
        return new DoomLoopResult(true, toolName, entry.getValue(), len);
      }
    }

    // Check for repeated tool calls with the same name+args (most reliable indicator).
    Map<String, Integer> toolCallFingerprints = new HashMap<>();
    Map<String, String> fingerprintToToolName = new HashMap<>();
    for (Message msg : recent) {
      if (msg.role() == Message.Role.ASSISTANT && msg.toolCalls() != null) {
        for (var tc : msg.toolCalls()) {
          String tcFingerprint = "tc:" + tc.name() + "|" + argsFingerprint(tc.args());
          toolCallFingerprints.merge(tcFingerprint, 1, Integer::sum);
          fingerprintToToolName.put(tcFingerprint, tc.name());
        }
      }
    }
    for (var entry : toolCallFingerprints.entrySet()) {
      if (entry.getValue() >= maxRecurrence) {
        log.info("Doom-loop detected: tool call {} appeared {} times in last {} messages",
            entry.getKey(), entry.getValue(), len);
        String toolName = fingerprintToToolName.getOrDefault(entry.getKey(), "");
        return new DoomLoopResult(true, toolName, entry.getValue(), len);
      }
    }

    // Check for repeated tool calls of the same NAME (ignoring arguments).
    Map<String, Integer> toolNameCounts = new HashMap<>();
    for (Message msg : recent) {
      if (msg.role() == Message.Role.ASSISTANT && msg.toolCalls() != null) {
        for (var tc : msg.toolCalls()) {
          toolNameCounts.merge(tc.name(), 1, Integer::sum);
        }
      }
    }
    for (var entry : toolNameCounts.entrySet()) {
      if (entry.getValue() >= maxToolCategoryRecurrence) {
        log.info("Doom-loop detected: tool '{}' called {} times in last {} messages (category-level loop)",
            entry.getKey(), entry.getValue(), len);
        return new DoomLoopResult(true, entry.getKey(), entry.getValue(), len);
      }
    }

    return DoomLoopResult.none();
  }

  private String fingerprint(Message msg) {
    if (msg.content() == null || msg.content().isBlank()) return "";
    if (msg.toolCalls() != null && !msg.toolCalls().isEmpty()) {
      // Include tool name + args fingerprint to avoid false positives when the same
      // tool is called with different arguments (e.g. fs.write to different files)
      StringBuilder sb = new StringBuilder("tool_calls:");
      for (var tc : msg.toolCalls()) {
        sb.append(tc.name()).append("|").append(argsFingerprint(tc.args())).append(",");
      }
      return sb.toString();
    }
    // Use first 200 chars of the trimmed content as fingerprint
    String trimmed = msg.content().trim();
    String excerpt = trimmed.substring(0, Math.min(200, trimmed.length()));
    excerpt = excerpt.replaceAll("\\s+", " "); // normalize whitespace
    // Hash the content to keep footprint small
    return "text:" + Integer.toHexString(excerpt.hashCode());
  }

  /** Create a stable fingerprint of tool call arguments for loop detection. */
  private String argsFingerprint(Map<String, Object> args) {
    if (args == null || args.isEmpty()) return "";
    // Sort keys for stability
    List<String> keys = new ArrayList<>(args.keySet());
    Collections.sort(keys);
    StringBuilder sb = new StringBuilder();
    for (String key : keys) {
      Object val = args.get(key);
      String valStr = val != null ? val.toString() : "null";
      // Truncate long values to keep fingerprint manageable
      if (valStr.length() > 100) valStr = valStr.substring(0, 100);
      sb.append(key).append("=").append(valStr).append(";");
    }
    return Integer.toHexString(sb.toString().hashCode());
  }
}

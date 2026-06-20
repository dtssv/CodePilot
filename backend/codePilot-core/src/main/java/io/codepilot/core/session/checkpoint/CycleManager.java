package io.codepilot.core.session.checkpoint;

import io.codepilot.core.session.Message;
import io.codepilot.core.session.SessionState;
import java.util.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Rebuild manager — reconstructs conversation context from checkpoint and recent message history
 * when the physical conversation window overflows past its limit.
 *
 * <p>
 *
 * <ol>
 *   <li>When context reaches the limit, write a checkpoint (via CheckpointWriter)
 *   <li>Create a new conversation cycle
 *   <li>Rebuild context from: checkpoint → start a new conversation window
 * </ol>
 *
 * <p>The agent will see:
 *
 * <ol>
 *   <li>System prompt (always fresh from PromptBuilder)
 *   <li>Checkpoint summary (injected as a system message)
 *   <li>Files-already-read manifest (injected as a system message)
 *   <li>Failed commands manifest (injected as a system message)
 *   <li>Recent messages (preserved as-is)
 * </ol>
 */
@Component
public class CycleManager {
  private static final Logger log = LoggerFactory.getLogger(CycleManager.class);

  /** Maximum number of cycles before stopping the session. */
  private static final int MAX_CYCLES = 10;

  /** Number of recent messages to keep when rebuilding. */
  private static final int KEEP_RECENT = 10;

  /** Tool names that represent file-read operations. */
  private static final Set<String> READ_TOOL_NAMES = Set.of("fs.read", "fs.list", "fs.search", "fs.grep", "fs.outline");

  /**
   * Rebuild context from a checkpoint.
   *
   * @param session the current session state
   * @param checkpoint checkpoint to inject
   * @return events stream (checkpoint event)
   */
  public CycleResult rebuild(SessionState session, String checkpoint) {
    List<Message> messages = session.getMessages();
    int originalSize = messages.size();
    boolean isWindows = session.getOsHint() != null
        && session.getOsHint().toLowerCase().contains("win");

    // 1. Extract structured info from ALL messages before discarding them
    String fileManifest = buildFileManifest(messages);
    String failedCommandsManifest = buildFailedCommandsManifest(messages, isWindows);
    String shellLessonsManifest = isWindows ? buildShellLessonsManifest(messages) : "";

    // 2. Get recent messages to preserve
    int keepStart = Math.max(0, messages.size() - KEEP_RECENT);
    List<Message> recent = new ArrayList<>(messages.subList(keepStart, messages.size()));

    // 3. Rebuild context
    session.getMessages().clear();

    // 4. Add checkpoint as a system context injection
    String checkpointMsg =
        """
        <context_rebuild checkpoint="%s">
        The conversation context has been rebuilt. Below is a summary of what happened so far.
        You should continue from where you left off as if the conversation was never interrupted.
        DO NOT re-read files listed in the files_already_read block below — content summaries are provided there.
        DO NOT retry commands listed in the failed_commands block below — they have already failed and need a different approach.

        %s
        </context_rebuild>
        """
            .formatted(session.getCheckpointToken(), checkpoint);
    session.addMessage(Message.system(checkpointMsg));

    // 5. Inject structured files-already-read manifest so the LLM knows exactly
    //    which files it has already explored and should not re-read.
    if (!fileManifest.isEmpty()) {
      session.addMessage(Message.system(fileManifest));
    }

    // 6. Inject failed commands manifest so the LLM knows which commands have
    //    already failed and must not be retried with the same or similar arguments.
    if (!failedCommandsManifest.isEmpty()) {
      session.addMessage(Message.system(failedCommandsManifest));
    }

    // 7. Inject shell lessons manifest (Windows only) so the LLM remembers
    //    PowerShell-specific rules extracted from failed commands in this session.
    if (!shellLessonsManifest.isEmpty()) {
      session.addMessage(Message.system(shellLessonsManifest));
    }

    // 8. Re-add the recent messages
    for (Message msg : recent) {
      session.addMessage(msg);
    }

    int newSize = session.getMessages().size();
    log.info(
        "Cycle completed for session {}: {} messages before, {} after rebuild",
        session.getSessionId(),
        originalSize,
        newSize);

    return new CycleResult(originalSize, newSize, MAX_CYCLES);
  }

  /**
   * Build a structured manifest of all files/directories that have already been read via
   * tool calls. Includes content summaries from TOOL result messages so the LLM does not
   * need to re-read files to recover the content it previously had in context.
   */
  private String buildFileManifest(List<Message> messages) {
    // First pass: map toolCallId → (toolName, path) for read tool calls
    Map<String, String> callIdToPath = new LinkedHashMap<>();
    for (Message msg : messages) {
      if (msg.role() != Message.Role.ASSISTANT || msg.toolCalls() == null) {
        continue;
      }
      for (var tc : msg.toolCalls()) {
        String path = extractReadPath(tc);
        if (path != null) {
          callIdToPath.put(tc.id(), path);
        }
      }
    }

    // Second pass: map toolCallId → content summary from TOOL result messages
    Map<String, String> pathToContentSummary = new LinkedHashMap<>();
    for (Message msg : messages) {
      if (msg.role() != Message.Role.TOOL || msg.toolCallId() == null) {
        continue;
      }
      String path = callIdToPath.get(msg.toolCallId());
      if (path != null && msg.content() != null && !msg.content().isBlank()
          && !"[pruned]".equals(msg.content())) {
        String content = msg.content();
        String summary = content.length() > 500 ? content.substring(0, 500) + "..." : content;
        // Keep the most recent content summary for each path
        pathToContentSummary.put(path, summary);
      }
    }

    // Third pass: collect all read targets (for paths without TOOL results too)
    Set<String> readPaths = new LinkedHashSet<>();
    Set<String> listedDirs = new LinkedHashSet<>();
    Set<String> searchedPatterns = new LinkedHashSet<>();

    for (Message msg : messages) {
      if (msg.role() != Message.Role.ASSISTANT || msg.toolCalls() == null) {
        continue;
      }
      for (var tc : msg.toolCalls()) {
        extractReadTargets(tc, readPaths, listedDirs, searchedPatterns);
      }
    }

    if (readPaths.isEmpty() && listedDirs.isEmpty() && searchedPatterns.isEmpty()) {
      return "";
    }

    StringBuilder sb = new StringBuilder();
    sb.append("<files_already_read>\n");
    sb.append("The following files and directories have already been read. Do NOT read them again unless ");
    sb.append("their content may have changed (e.g. you just wrote to them) or you need more detail.\n");
    sb.append("Content summaries are provided below for reference.\n\n");

    if (!readPaths.isEmpty()) {
      sb.append("Files read:\n");
      for (String path : readPaths) {
        sb.append("  - ").append(path);
        String contentSummary = pathToContentSummary.get(path);
        if (contentSummary != null) {
          sb.append(":\n    ").append(contentSummary.replace("\n", "\n    "));
        }
        sb.append("\n");
      }
      sb.append("\n");
    }

    if (!listedDirs.isEmpty()) {
      sb.append("Directories listed:\n");
      for (String dir : listedDirs) {
        sb.append("  - ").append(dir).append("\n");
      }
      sb.append("\n");
    }

    if (!searchedPatterns.isEmpty()) {
      sb.append("Searches performed:\n");
      for (String pattern : searchedPatterns) {
        sb.append("  - ").append(pattern).append("\n");
      }
      sb.append("\n");
    }

    sb.append("</files_already_read>");
    return sb.toString();
  }

  /** Extract the file path from a read-type tool call entry. Returns null if not a read tool. */
  private String extractReadPath(Message.ToolCallEntry tc) {
    String name = tc.name();
    Map<String, Object> args = tc.args();
    if (args == null) return null;

    return switch (name) {
      case "fs.read" -> args.get("path") != null ? args.get("path").toString() : null;
      case "fs.list" -> args.get("path") != null ? args.get("path").toString() : null;
      case "fs.outline" -> args.get("path") != null ? args.get("path").toString() : null;
      default -> null;
    };
  }

  /** Extract file/directory targets from a tool call entry. */
  private void extractReadTargets(
      Message.ToolCallEntry tc,
      Set<String> readPaths,
      Set<String> listedDirs,
      Set<String> searchedPatterns) {

    String name = tc.name();
    Map<String, Object> args = tc.args();
    if (args == null) return;

    switch (name) {
      case "fs.read" -> {
        Object path = args.get("path");
        if (path != null && !path.toString().isBlank()) {
          readPaths.add(path.toString());
        }
      }
      case "fs.list" -> {
        Object path = args.get("path");
        if (path != null && !path.toString().isBlank()) {
          listedDirs.add(path.toString());
        }
      }
      case "fs.search" -> {
        Object pattern = args.get("pattern");
        Object path = args.get("path");
        String desc = (pattern != null ? pattern.toString() : "*");
        if (path != null) desc += " (in " + path + ")";
        searchedPatterns.add("search:" + desc);
      }
      case "fs.grep" -> {
        Object pattern = args.get("pattern");
        Object path = args.get("path");
        String desc = (pattern != null ? pattern.toString() : "*");
        if (path != null) desc += " (in " + path + ")";
        searchedPatterns.add("grep:" + desc);
      }
      case "fs.outline" -> {
        Object path = args.get("path");
        if (path != null && !path.toString().isBlank()) {
          readPaths.add(path.toString() + " (outline)");
        }
      }
      default -> {
        // Not a read tool — skip
      }
    }
  }

  /**
   * Build a structured manifest of tool calls that produced error results. This is injected
   * as a system message after rebuild so the LLM knows which commands have already failed
   * and must not be retried with the same or similar arguments.
   *
   * <p>For shell.exec failures on Windows, a PowerShell-specific hint is appended to help
   * the agent avoid repeating the same escaping mistakes.
   */
  private String buildFailedCommandsManifest(List<Message> messages, boolean isWindows) {
    // Map toolCallId → (toolName, args summary)
    Map<String, String[]> callIdToTool = new LinkedHashMap<>();
    // Collect (toolName, argsSummary, errorExcerpt) for failed commands
    List<String[]> failedEntries = new ArrayList<>();

    for (int i = 0; i < messages.size(); i++) {
      Message msg = messages.get(i);
      if (msg.role() == Message.Role.ASSISTANT && msg.toolCalls() != null) {
        for (var tc : msg.toolCalls()) {
          String argsSummary = summarizeToolArgs(tc.name(), tc.args());
          callIdToTool.put(tc.id(), new String[]{tc.name(), argsSummary});
        }
      } else if (msg.role() == Message.Role.TOOL && msg.toolCallId() != null) {
        String content = msg.content() != null ? msg.content() : "";
        if (containsErrorIndicator(content)) {
          String[] toolInfo = callIdToTool.get(msg.toolCallId());
          if (toolInfo != null) {
            String errorExcerpt = content.length() > 150
                ? content.substring(0, 150) + "..."
                : content;
            // Normalize whitespace for compact display
            errorExcerpt = errorExcerpt.replaceAll("\\s+", " ").trim();
            // Append PowerShell hint for shell.exec failures on Windows
            String hint = "";
            if (isWindows && "shell.exec".equals(toolInfo[0])) {
              hint = buildPowerShellHint(toolInfo[1], errorExcerpt);
            }
            failedEntries.add(new String[]{toolInfo[0], toolInfo[1], errorExcerpt, hint});
          }
        }
      }
    }

    if (failedEntries.isEmpty()) {
      return "";
    }

    // Deduplicate: same tool name + similar args → keep only one entry
    Set<String> seen = new LinkedHashSet<>();
    List<String[]> unique = new ArrayList<>();
    for (String[] entry : failedEntries) {
      String key = entry[0] + "|" + entry[1];
      if (seen.add(key)) {
        unique.add(entry);
      }
    }

    StringBuilder sb = new StringBuilder();
    sb.append("<failed_commands>\n");
    sb.append("The following commands FAILED. Do NOT retry them with the same or similar arguments.\n");
    sb.append("You MUST use a completely different approach instead.\n\n");

    for (String[] entry : unique) {
      sb.append("  - ").append(entry[0]);
      if (!entry[1].isEmpty()) {
        sb.append("(").append(entry[1]).append(")");
      }
      sb.append(" → ").append(entry[2]);
      if (entry.length > 3 && !entry[3].isEmpty()) {
        sb.append("\n    ").append(entry[3]);
      }
      sb.append("\n");
    }

    sb.append("\n</failed_commands>");
    return sb.toString();
  }

  /**
   * Build a PowerShell-specific hint for a failed shell.exec command.
   * Detects common PowerShell escaping mistakes in the command or error output.
   */
  private String buildPowerShellHint(String commandArgs, String errorOutput) {
    List<String> hints = new ArrayList<>();
    String combined = (commandArgs + " " + errorOutput).toLowerCase();

    // Detect bash-style escaping (\") used instead of PowerShell backtick (")
    if (commandArgs.contains("\\\"")) {
      hints.add("Use backtick (`) to escape double quotes in PowerShell, NOT backslash (\\)");
    }
    // Detect bash-style dollar escaping (\$) used instead of PowerShell backtick ($)
    if (commandArgs.contains("\\$")) {
      hints.add("Use backtick (`) to escape $ in PowerShell, NOT backslash (\\)");
    }
    // Detect unescaped $ in double-quoted strings that likely caused variable expansion
    if (combined.contains("variable") || combined.contains("cannot find") || combined.contains("unexpected token")) {
      hints.add("The $ sign triggers variable expansion — escape with backtick (`$) or use single quotes");
    }
    // Detect path with spaces not quoted
    if (combined.contains("not recognized") || combined.contains("could not find")) {
      hints.add("Wrap paths containing spaces in double quotes");
    }

    if (hints.isEmpty()) {
      return "[PowerShell hint: Use backtick (`) for escaping, NOT backslash (\\). "
          + "Try cmd /c as a fallback if escaping keeps failing.]";
    }
    return "[PowerShell hint: " + String.join("; ", hints) + "]";
  }

  /** Build a compact summary of tool call arguments for the failed commands manifest. */
  private String summarizeToolArgs(String toolName, Map<String, Object> args) {
    if (args == null || args.isEmpty()) return "";

    // For shell.exec, show the command that was run
    if ("shell.exec".equals(toolName) && args.containsKey("command")) {
      String cmd = String.valueOf(args.get("command"));
      return cmd.length() > 120 ? cmd.substring(0, 120) + "..." : cmd;
    }

    // For other tools, show key arguments concisely
    List<String> parts = new ArrayList<>();
    for (var entry : args.entrySet()) {
      if ("cwd".equals(entry.getKey())) continue; // skip working directory
      String val = String.valueOf(entry.getValue());
      if (val.length() > 80) val = val.substring(0, 80) + "...";
      parts.add(entry.getKey() + "=" + val);
    }
    String result = String.join(", ", parts);
    return result.length() > 200 ? result.substring(0, 200) + "..." : result;
  }

  /**
   * Build a manifest of PowerShell lessons learned from failed shell.exec commands in this
   * session. This is injected as a system message after rebuild on Windows sessions so the
   * LLM is reminded of PowerShell-specific rules and avoids repeating the same escaping mistakes.
   */
  private String buildShellLessonsManifest(List<Message> messages) {
    // Collect error patterns from failed shell.exec commands
    boolean hasShellExecFailure = false;
    boolean hasEscapeIssue = false;
    boolean hasPathSpaceIssue = false;
    boolean hasUnixCommandIssue = false;

    // Map toolCallId → (toolName, args)
    Map<String, String[]> callIdToTool = new LinkedHashMap<>();
    for (Message msg : messages) {
      if (msg.role() == Message.Role.ASSISTANT && msg.toolCalls() != null) {
        for (var tc : msg.toolCalls()) {
          callIdToTool.put(tc.id(), new String[]{tc.name(),
              tc.args() != null && tc.args().containsKey("command")
                  ? String.valueOf(tc.args().get("command")) : ""});
        }
      } else if (msg.role() == Message.Role.TOOL && msg.toolCallId() != null) {
        String content = msg.content() != null ? msg.content() : "";
        if (!containsErrorIndicator(content)) continue;
        String[] toolInfo = callIdToTool.get(msg.toolCallId());
        if (toolInfo == null || !"shell.exec".equals(toolInfo[0])) continue;
        hasShellExecFailure = true;
        String cmd = toolInfo[1];
        String combined = (cmd + " " + content).toLowerCase();

        // Detect common PowerShell escaping problems
        if (cmd.contains("\\$") || cmd.contains("\\\"")
            || combined.contains("unexpected token") || combined.contains("parse error")) {
          hasEscapeIssue = true;
        }
        if (combined.contains("not recognized") || combined.contains("could not find")
            || combined.contains("cannot find")) {
          hasPathSpaceIssue = true;
        }
        if (combined.contains("grep") || combined.contains("sed") || combined.contains("cat ")
            || combined.contains(" rm ") || combined.contains("which ")) {
          hasUnixCommandIssue = true;
        }
      }
    }

    if (!hasShellExecFailure) {
      return "";
    }

    StringBuilder sb = new StringBuilder();
    sb.append("<shell_lessons>\n");
    sb.append("Based on previous command failures in this session, remember these PowerShell rules:\n");

    // Always include core rules if there were any shell failures
    sb.append("- PowerShell uses backtick (`) for escaping, NOT backslash (\\)\n");

    if (hasEscapeIssue) {
      sb.append("- The $ sign triggers variable expansion in double-quoted strings — escape with backtick (`$)\n");
      sb.append("- Escape double quotes with backtick (`\") NOT backslash (\\\")\n");
    }
    if (hasPathSpaceIssue) {
      sb.append("- Always wrap paths with spaces in double quotes\n");
    }
    if (hasUnixCommandIssue) {
      sb.append("- Use PowerShell equivalents: Select-String (not grep), -replace (not sed), "
          + "Get-Content (not cat), Get-Command (not which)\n");
    }

    sb.append("- If a command keeps failing, try cmd /c as a fallback to use cmd.exe syntax\n");
    sb.append("</shell_lessons>");
    return sb.toString();
  }

  /** Check whether a tool result content indicates a failure. */
  private boolean containsErrorIndicator(String content) {
    if (content == null || content.isBlank()) return false;
    String lower = content.toLowerCase();
    return lower.contains("error")
        || lower.contains("failed")
        || lower.contains("failure")
        || lower.contains("exit code")
        || lower.contains("syntaxerror")
        || lower.contains("traceback")
        || lower.contains("exception")
        || lower.contains("denied")
        || lower.contains("timed out")
        || lower.contains("not found")
        || lower.contains("permission denied");
  }

  public record CycleResult(int messagesBefore, int messagesAfter, int maxCycles) {}
}

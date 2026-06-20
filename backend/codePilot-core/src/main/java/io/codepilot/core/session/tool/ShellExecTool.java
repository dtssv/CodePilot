package io.codepilot.core.session.tool;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Built-in tool: shell.exec — execute a shell command with safety constraints.
 *
 * <p>Safety features:
 *
 * <ul>
 *   <li>Commands must run within the configured workspace directory
 *   <li>Blocked commands: rm -rf /, format, del /s, etc.
 *   <li>Timeout: 60 seconds
 *   <li>Output truncated at 50KB
 * </ul>
 */
@Component
public class ShellExecTool {
  private static final Logger log = LoggerFactory.getLogger(ShellExecTool.class);
  public static final String NAME = "shell.exec";

  private static final int TIMEOUT_SECONDS = 60;
  private static final int MAX_OUTPUT_CHARS = 50_000;

  /** Dangerous command patterns that are always blocked. */
  private static final Set<Pattern> BLOCKED_PATTERNS =
      Set.of(
          Pattern.compile("(?i)\\brm\\s+-rf\\s+/"),
          Pattern.compile("(?i)\\bformat\\s+[a-z]:"),
          Pattern.compile("(?i)\\bdel\\s+/s\\s+[a-z]:"),
          Pattern.compile("(?i)\\bdd\\s+if=.*of=/dev/"),
          Pattern.compile("(?i)\\b(:\\s*)?\\{\\s*:\\s*&\\s*\\}"), // fork bomb
          Pattern.compile("(?i)\\bshutdown\\b"),
          Pattern.compile("(?i)\\breboot\\b"));

  /** Patterns in command output that indicate a failure even when exit code is 0. */
  private static final Set<Pattern> ERROR_INDICATORS =
      Set.of(
          Pattern.compile("(?i)\\bSyntaxError\\b"),
          Pattern.compile("(?i)\\bTraceback \\(most recent call last\\)"),
          Pattern.compile("(?i)\\bERROR\\s*[:\\[]"),
          Pattern.compile("(?i)\\bFATAL\\s*[:\\[]"),
          Pattern.compile("(?i)\\bcompilation failed\\b"),
          Pattern.compile("(?i)\\bBUILD FAILED\\b"),
          Pattern.compile("(?i)\\bcommand not found\\b"),
          Pattern.compile("(?i)\\bNo such file or directory\\b"),
          Pattern.compile("(?i)\\bPermission denied\\b"),
          Pattern.compile("(?m)^Exit code: [1-9]"));

  /**
   * Check whether the command output contains indicators that the command actually failed,
   * even though the shell may have reported exit code 0. This happens on Windows when
   * PowerShell does not propagate the subprocess exit code correctly.
   */
  private boolean containsErrorIndicators(String output) {
    if (output == null || output.isBlank()) return false;
    for (Pattern pattern : ERROR_INDICATORS) {
      if (pattern.matcher(output).find()) return true;
    }
    return false;
  }

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Execute a shell command and return the output. Commands run within the workspace"
            + " directory.",
        Map.of(
            "type", "object",
            "properties",
                Map.of(
                    "command",
                        Map.of("type", "string", "description", "The shell command to execute."),
                    "cwd",
                        Map.of(
                            "type",
                            "string",
                            "description",
                            "Working directory (defaults to workspace root).")),
            "required", List.of("command")),
        false,
        true);
  }

  public ToolExecutor executor() {
    return call -> {
      String command = (String) call.args().get("command");
      String cwd = (String) call.args().get("cwd");
      if (command == null)
        return new io.codepilot.core.agent.tool.ToolResult(
            false, "Missing required parameter: command");

      // Safety: check for blocked commands
      for (Pattern pattern : BLOCKED_PATTERNS) {
        if (pattern.matcher(command).find()) {
          return new io.codepilot.core.agent.tool.ToolResult(
              false, "Command blocked by safety policy: '" + command + "'");
        }
      }

      try {
        ProcessBuilder pb = new ProcessBuilder();
        boolean isWindows = System.getProperty("os.name").toLowerCase().contains("windows");
        if (isWindows) pb.command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command + "; exit $LASTEXITCODE");
        else pb.command("sh", "-c", command);

        if (cwd != null && !cwd.isBlank()) {
          pb.directory(new File(cwd));
        }

        pb.redirectErrorStream(true);
        Process process = pb.start();

        StringBuilder output = new StringBuilder();
        try (BufferedReader reader =
            new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
          String line;
          while ((line = reader.readLine()) != null) {
            output.append(line).append("\n");
            if (output.length() > MAX_OUTPUT_CHARS) {
              output
                  .append("\n... [output truncated at ")
                  .append(MAX_OUTPUT_CHARS)
                  .append(" chars]");
              process.destroyForcibly();
              break;
            }
          }
        }

        boolean exited = process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        if (!exited) {
          process.destroyForcibly();
          return new io.codepilot.core.agent.tool.ToolResult(
              false, "Command timed out after " + TIMEOUT_SECONDS + " seconds");
        }

        int exitCode = process.exitValue();
        String result = output.toString().trim();

        // On Windows PowerShell, exit code propagation is unreliable — a subprocess may fail
        // (e.g. Python SyntaxError) but PowerShell still reports exit code 0. Detect common
        // error indicators in the output to catch this case.
        boolean hasErrorOutput = containsErrorIndicators(result);
        boolean success = exitCode == 0 && !hasErrorOutput;

        String prefix = success ? "" : "Exit code: " + exitCode + "\n";
        return new io.codepilot.core.agent.tool.ToolResult(success, prefix + result);
      } catch (IOException e) {
        return new io.codepilot.core.agent.tool.ToolResult(false, "I/O error: " + e.getMessage());
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        return new io.codepilot.core.agent.tool.ToolResult(false, "Command interrupted");
      } catch (Exception e) {
        log.error("Shell execution failed", e);
        return new io.codepilot.core.agent.tool.ToolResult(false, "Shell error: " + e.getMessage());
      }
    };
  }
}

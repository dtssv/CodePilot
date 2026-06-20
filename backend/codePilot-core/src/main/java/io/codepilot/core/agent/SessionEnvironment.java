package io.codepilot.core.agent;

import lombok.Getter;

/**
 * Immutable session-level environment record for the AgentLoop.
 *
 * <p>Mirrors the graph engine's {@code SessionExecutionFacts} pattern: built once during intake,
 * never modified, passed through every prompt builder and recovery helper so every phase has OS
 * awareness.
 *
 * <p>Contains convenience methods ({@link #isWindows()}, {@link #shellName()}, {@link
 * #pathSeparator()}) so callers don't need to repeat OS-checking logic.
 */
@Getter
public final class SessionEnvironment {

  private final String osHint;
  private final String workspaceRoot;
  private final String projectMeta;

  private SessionEnvironment(String osHint, String workspaceRoot, String projectMeta) {
    this.osHint = osHint != null ? osHint : "";
    this.workspaceRoot = workspaceRoot != null ? workspaceRoot : "";
    this.projectMeta = projectMeta != null ? projectMeta : "";
  }

  public static SessionEnvironment of(String osHint, String workspaceRoot, String projectMeta) {
    return new SessionEnvironment(osHint, workspaceRoot, projectMeta);
  }

  public static SessionEnvironment empty() {
    return new SessionEnvironment("", "", "");
  }

  // ── Getters ──────────────────────────────────────────────────

  // ── OS-aware convenience methods (mirrors graph SessionExecutionFacts) ──

  public boolean isWindows() {
    return osHint.toLowerCase().contains("win");
  }

  public boolean isMac() {
    return osHint.toLowerCase().contains("mac") || osHint.toLowerCase().contains("darwin");
  }

  public boolean isLinux() {
    return !isWindows() && !isMac();
  }

  public String shellName() {
    if (isWindows()) return "powershell";
    if (isMac()) return "zsh";
    return "bash";
  }

  public String pathSeparator() {
    return isWindows() ? "\\" : "/";
  }

  /** Normalizes a file path to use the correct separator for the current OS. */
  public String normalizePath(String path) {
    if (path == null) return null;
    return isWindows() ? path.replace("/", "\\") : path.replace("\\", "/");
  }

  /**
   * Builds the environment section for the system prompt, following the graph engine's pattern
   * where OS and workspace info are always included.
   */
  public String toPromptSection() {
    StringBuilder sb = new StringBuilder();
    sb.append("## Environment\n");
    if (!osHint.isBlank()) {
      sb.append("Operating system: ").append(osHint).append("\n");
      sb.append("Shell: ").append(shellName()).append("\n");
      sb.append("Path separator: ").append(pathSeparator()).append("\n");
    } else if (!workspaceRoot.isBlank()) {
      // Fallback: detect OS from workspace root path format
      if (workspaceRoot.matches("^[A-Za-z]:.*")) {
        sb.append("Operating system: windows\n");
        sb.append("Shell: powershell\n");
        sb.append("Path separator: \\\n");
      } else {
        sb.append("Operating system: linux\n");
        sb.append("Shell: bash\n");
        sb.append("Path separator: /\n");
      }
    }
    if (!workspaceRoot.isBlank()) {
      sb.append("Workspace root: ").append(workspaceRoot).append("\n");
    }
    sb.append(
        "IMPORTANT: Always use relative paths for file tools (fs.read, fs.write, etc.). "
            + "Paths are resolved relative to the workspace root. Do NOT use absolute paths. ");
    if (isWindows()) {
      sb.append("Do NOT use Linux-style paths like /mnt/d/... or /home/... on Windows.");
    }
    return sb.toString();
  }

  /** Builds an OS-aware path error recovery hint for the recovery engine. */
  public String pathErrorHint() {
    StringBuilder sb = new StringBuilder();
    sb.append("The path you used is invalid or outside the workspace. ");
    if (!osHint.isBlank()) {
      sb.append("The OS is ").append(osHint).append(". ");
    }
    if (!workspaceRoot.isBlank()) {
      sb.append("The workspace root is ").append(workspaceRoot).append(". ");
    }
    sb.append("Use RELATIVE paths only (e.g., 'src/main.cpp'), NOT absolute paths. ");
    if (isWindows()) {
      sb.append("Do NOT use Linux-style absolute paths like /mnt/d/... on Windows. ");
    }
    return sb.toString();
  }

  /** Builds an OS-aware command hint for the system prompt. */
  public String commandHint() {
    if (isWindows()) {
      return "Use Windows-compatible commands (PowerShell). Avoid Unix-specific commands like"
          + " chmod, grep, sed, cat — use PowerShell equivalents instead.";
    }
    return "Use POSIX-compatible commands (bash/zsh).";
  }
}

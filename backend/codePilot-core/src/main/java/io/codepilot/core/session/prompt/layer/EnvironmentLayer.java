package io.codepilot.core.session.prompt.layer;

import io.codepilot.core.session.SessionState;
import io.codepilot.core.session.prompt.PromptContext;
import io.codepilot.core.session.prompt.PromptLayer;
import org.springframework.stereotype.Component;

/**
 * Environment layer — provides the model with workspace context, OS info, and path conventions.
 *
 * <p>Priority: 10 (after identity, before tools).
 */
@Component
public class EnvironmentLayer implements PromptLayer {
  @Override
  public int priority() {
    return 10;
  }

  @Override
  public String build(PromptContext ctx) {
    var session = ctx.session();
    StringBuilder sb = new StringBuilder();
    sb.append("Here is useful information about the environment you are running in:\n");
    sb.append("<env>\n");

    // OS and shell info
    String osHint = session.getOsHint();
    boolean isWindows = osHint != null && osHint.toLowerCase().contains("win");
    if (osHint != null && !osHint.isBlank()) {
      sb.append("  Operating system: ").append(osHint).append("\n");
      sb.append("  Shell: ").append(isWindows ? "powershell" : "bash").append("\n");
    } else if (session.getWorkspaceRoot() != null
        && !session.getWorkspaceRoot().isBlank()
        && session.getWorkspaceRoot().matches("^[A-Za-z]:.*")) {
      // Fallback: detect Windows from workspace root path format
      sb.append("  Operating system: windows\n");
      sb.append("  Shell: powershell\n");
      isWindows = true;
    }

    // Workspace root
    if (session.getWorkspaceRoot() != null && !session.getWorkspaceRoot().isBlank()) {
      sb.append("  Workspace folder: ").append(session.getWorkspaceRoot()).append("\n");
    }

    sb.append("  Current date: ").append(java.time.LocalDate.now()).append("\n");

    // Path conventions
    sb.append("  Note: Always use paths under the workspace folder. ");
    if (isWindows) {
      sb.append("This is a Windows system — use Windows-style paths (e.g. C:\\Users\\...) "
          + "and do NOT use Linux-style paths like /data/workspace or /home/...");
    } else {
      sb.append("Prefer using absolute paths over relative paths as tool call args when possible.");
    }
    sb.append("\n");

    sb.append("</env>\n");
    return sb.toString();
  }
}

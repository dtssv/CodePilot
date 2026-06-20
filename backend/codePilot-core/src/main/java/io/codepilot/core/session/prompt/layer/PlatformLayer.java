package io.codepilot.core.session.prompt.layer;

import io.codepilot.core.session.prompt.PromptContext;
import io.codepilot.core.session.prompt.PromptLayer;
import org.springframework.stereotype.Component;

/**
 * Platform layer — provides platform-specific instructions.
 *
 * <p>Priority: 5 (right after identity, before environment).
 */
@Component
public class PlatformLayer implements PromptLayer {
  @Override
  public int priority() {
    return 5;
  }

  @Override
  public String build(PromptContext ctx) {
    var session = ctx.session();
    String osHint = session.getOsHint();
    if (osHint == null) return "";

    StringBuilder sb = new StringBuilder();
    sb.append("You are running on ");
    sb.append(osHint).append(". ");
    if (osHint.toLowerCase().contains("windows")) {
      sb.append("Use Windows-style paths and commands. For shell commands, use PowerShell.\n\n");
      sb.append("""
          ## PowerShell Command Guidelines (CRITICAL)

          When using shell.exec on Windows PowerShell, follow these rules to avoid common escaping errors:

          1. **Escape character is backtick (`)**, NOT backslash (\\). Backslash is a literal character in PowerShell.
             - Correct: Write-Output "hello `$name"   (backtick before $)
             - Wrong:   Write-Output "hello \\$name"   (backslash does not escape in PS)

          2. **Dollar sign $** triggers variable expansion in double-quoted strings. To use a literal $:
             - In double quotes: escape with backtick like `$var
             - Or use single quotes: '$var' (no expansion in single quotes)

          3. **Paths with spaces** must be wrapped in double quotes:
             - Correct: cd "C:\\Program Files\\My App"
             - Wrong:   cd C:\\Program Files\\My App

          4. **Double quotes inside strings**: escape with backtick `" not backslash \\"
             - Correct: Write-Output "hello `"world`""
             - Wrong:   Write-Output "hello \\"world\\""

          5. **Avoid Unix commands** — use PowerShell equivalents:
             - Select-String instead of grep
             - -replace operator instead of sed
             - Get-Content instead of cat
             - Get-Command instead of which
             - Remove-Item instead of rm
             - Copy-Item instead of cp

          6. **Special characters that need quoting/escaping in PowerShell**: |, >, >>, &, {, }, @, (, )

          7. **When commands keep failing with parse errors**, try using cmd /c as a fallback:
             - cmd /c "echo hello" uses cmd.exe syntax instead of PowerShell
          """);
    } else {
      sb.append("Use Unix-style paths and commands.");
    }
    return sb.toString();
  }
}

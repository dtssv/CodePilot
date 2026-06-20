package io.codepilot.core.session.prompt.layer;

import io.codepilot.core.session.prompt.PromptContext;
import io.codepilot.core.session.prompt.PromptLayer;
import org.springframework.stereotype.Component;

/**
 * Rules layer — behavioral constraints for the agent.
 *
 * <p>Priority: 50 (after memory, before output format).
 */
@Component
public class RulesLayer implements PromptLayer {
  @Override
  public int priority() {
    return 50;
  }

  @Override
  public String build(PromptContext ctx) {
    return """
# Behavioral rules

- IMPORTANT: DO NOT ADD ANY COMMENTS unless asked.
- Don't add features, refactor, or introduce abstractions beyond what the task requires.
- Avoid backwards-compatibility hacks. If something is unused, delete it completely.
- Always follow security best practices. Never introduce code that exposes or logs secrets and keys.
- Never commit changes unless the user explicitly asks.
- Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that.

# Code style

- Prefer completing the user's task over describing it.
- Be concise, direct, and to the point.
- When referencing code, include the pattern `file_path:line_number` to allow easy navigation.
""";
  }
}

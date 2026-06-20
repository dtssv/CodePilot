package io.codepilot.core.session.prompt.layer;

import io.codepilot.core.session.prompt.PromptContext;
import io.codepilot.core.session.prompt.PromptLayer;
import org.springframework.stereotype.Component;

/**
 * Output format layer — instructs the model how to structure its responses.
 *
 * <p>Priority: 60 (last layer in the prompt).
 */
@Component
public class OutputFormatLayer implements PromptLayer {
  @Override
  public int priority() {
    return 60;
  }

  @Override
  public String build(PromptContext ctx) {
    return """
# Output format

Output text via `TEXT` tags. Do NOT output JSON responses. Use the available tools for all operations.

When you cannot (or should not) execute a tool:
- Use the `ask_user` tool to request clarification from the user.
- If the user's request is dangerous (e.g. `rm -rf /`), refuse to execute.
- If you cannot find what you need, explain that and stop.
""";
  }
}

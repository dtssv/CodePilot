package io.codepilot.core.session.prompt.layer;

import io.codepilot.core.session.prompt.PromptContext;
import io.codepilot.core.session.prompt.PromptLayer;
import org.springframework.stereotype.Component;

/**
 * Memory layer — injects persistent memories from prior sessions.
 *
 * <p>Priority: 40 (after context, before rules).
 */
@Component
public class MemoryLayer implements PromptLayer {
  @Override
  public int priority() {
    return 40;
  }

  @Override
  public String build(PromptContext ctx) {
    String memoryContext = ctx.session().getMemoryContext();
    if (memoryContext == null || memoryContext.isBlank()) {
      return "";
    }
    return "# Memory context\n\n"
        + "The following context memory has been loaded from prior sessions:\n\n"
        + memoryContext;
  }
}

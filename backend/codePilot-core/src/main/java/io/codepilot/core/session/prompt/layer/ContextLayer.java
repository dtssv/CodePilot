package io.codepilot.core.session.prompt.layer;

import io.codepilot.core.session.prompt.PromptContext;
import io.codepilot.core.session.prompt.PromptLayer;
import org.springframework.stereotype.Component;

/**
 * Context layer — injects context about the project.
 *
 * <p>Priority: 30 (after tools, before memory).
 */
@Component
public class ContextLayer implements PromptLayer {
  @Override
  public int priority() {
    return 30;
  }

  @Override
  public String build(PromptContext ctx) {
    var session = ctx.session();
    StringBuilder sb = new StringBuilder();
    sb.append("# Project context\n\n");

    if (session.getProjectMeta() != null && !session.getProjectMeta().isBlank()) {
      sb.append("Project metadata:\n");
      sb.append(session.getProjectMeta()).append("\n\n");
    }

    return sb.toString();
  }
}

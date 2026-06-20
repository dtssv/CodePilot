package io.codepilot.core.session.prompt;

import io.codepilot.core.session.SessionState;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import org.springframework.stereotype.Component;

/**
 * Assembles the system prompt by composing multiple {@link PromptLayer}s.
 *
 * <p>Replaces the old {@code PromptOrchestrator} with a cleaner layered design inspired by
 * Layered prompt construction.
 *
 * <p>Order of layers:
 *
 * <ol>
 *   <li>Identity — who the agent is
 *   <li>Environment — workspace, OS, shell info
 *   <li>Tool Instructions — how to use each available tool
 *   <li>Context — file map, open files
 *   <li>Memory — injected persistent memories
 *   <li>Rules — behavioral constraints
 *   <li>Output Format — how to structure responses
 * </ol>
 */
@Component
public class PromptBuilder {

  private final List<PromptLayer> layers = new ArrayList<>();

  /** Constructor collects all available PromptLayer beans. */
  public PromptBuilder(List<PromptLayer> layers) {
    this.layers.addAll(layers);
    this.layers.sort(Comparator.comparingInt(PromptLayer::priority));
  }

  /** Build the complete system prompt for a session. */
  public String build(SessionState session) {
    PromptContext ctx =
        new PromptContext(
            session,
            session.getModelId(),
            session.getModelId()); // Simplified — in production we'd resolve the model name

    StringBuilder sb = new StringBuilder();
    for (PromptLayer layer : layers) {
      String text = layer.build(ctx);
      if (text != null && !text.isBlank()) {
        if (sb.length() > 0) {
          sb.append("\n\n");
        }
        sb.append(text);
      }
    }
    return sb.toString();
  }
}

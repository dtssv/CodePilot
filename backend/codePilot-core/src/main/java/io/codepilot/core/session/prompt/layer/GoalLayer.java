package io.codepilot.core.session.prompt.layer;

import io.codepilot.core.agent.goal.GoalCondition;
import io.codepilot.core.session.prompt.PromptContext;
import io.codepilot.core.session.prompt.PromptLayer;
import org.springframework.stereotype.Component;

/**
 * Injects the active goal condition into the system prompt when one is set.
 *
 * <p>Priority: 5 (early, right after identity).
 */
@Component
public class GoalLayer implements PromptLayer {
  @Override
  public int priority() {
    return 5;
  }

  @Override
  public String build(PromptContext ctx) {
    String goalCondition = ctx.session().getGoalCondition();
    if (goalCondition == null || goalCondition.isBlank()) return "";

    GoalCondition goal = GoalCondition.parse(goalCondition);
    if (goal == null) return "";

    return goal.toPromptSection();
  }
}

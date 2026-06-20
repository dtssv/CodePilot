package io.codepilot.core.agent.goal;

/**
 * Represents a structured goal condition for the agent.
 *
 * <p>Parsed from the user's goal string, this provides a clear success criteria that the GoalJudge
 * evaluates against.
 */
public class GoalCondition {

  private final String rawGoal;
  private final String successCriteria;
  private final String verificationMethod;

  public GoalCondition(String rawGoal, String successCriteria, String verificationMethod) {
    this.rawGoal = rawGoal;
    this.successCriteria = successCriteria;
    this.verificationMethod = verificationMethod;
  }

  public String rawGoal() {
    return rawGoal;
  }

  public String successCriteria() {
    return successCriteria;
  }

  public String verificationMethod() {
    return verificationMethod;
  }

  /**
   * Parse a goal condition from a raw string. If the string contains structured markers, parse
   * them. Otherwise, treat the entire string as the success criteria.
   */
  public static GoalCondition parse(String goal) {
    if (goal == null || goal.isBlank()) return null;

    String successCriteria = goal;
    String verificationMethod = "manual_review";

    // Simple heuristic: if the goal contains "verify" or "check", extract verification
    String lower = goal.toLowerCase();
    if (lower.contains("verify by") || lower.contains("check by")) {
      String[] parts = goal.split("(?i)verify by|check by", 2);
      successCriteria = parts[0].trim();
      if (parts.length > 1) {
        verificationMethod = parts[1].trim();
      }
    }

    return new GoalCondition(goal, successCriteria, verificationMethod);
  }

  /** Format as a system prompt section. */
  public String toPromptSection() {
    return """
           # Goal Condition

           The task will be considered complete when:

           **Success Criteria**: %s

           **Verification Method**: %s

           Do NOT stop until the success criteria above are fully met.
           """
        .formatted(successCriteria, verificationMethod);
  }

  @Override
  public String toString() {
    return rawGoal;
  }
}

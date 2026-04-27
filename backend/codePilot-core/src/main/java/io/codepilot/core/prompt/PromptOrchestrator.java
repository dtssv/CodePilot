package io.codepilot.core.prompt;

import io.codepilot.common.conversation.ConversationRequest;
import io.codepilot.common.conversation.ConversationRequest.Mode;
import io.codepilot.common.conversation.ConversationRequest.UserSkill;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.stereotype.Service;

/**
 * Assembles the multi-segment system prompt and user message sequence for a single model call.
 *
 * <p>Segments are appended in strict order per the design doc §6.1:
 *
 * <ol>
 *   <li>base.system — identity, cardinal rules, output discipline
 *   <li>chat.system OR agent.system — mode-specific contract
 *   <li>tools.schema — available tools JSON Schema (agent only)
 *   <li>compact.system — conditional: context compression triggered
 *   <li>guard.system — security guard rail
 *   <li>user-skill segments — wrapped in [USER_SKILL_BEGIN]…[USER_SKILL_END]
 * </ol>
 */
@Service
public class PromptOrchestrator {

  private final PromptRegistry registry;
  private final ContextBudgeter budgeter;

  public PromptOrchestrator(PromptRegistry registry, ContextBudgeter budgeter) {
    this.registry = registry;
    this.budgeter = budgeter;
  }

  /**
   * Assembles a Spring AI {@link Prompt} for the given conversation request and agent state.
   *
   * @param req the incoming conversation request
   * @param state mutable agent loop state (messages, steps, last plan); null for first turn
   * @param toolsSchema JSON string of available tools schema (agent only)
   */
  public Prompt assemble(ConversationRequest req, AgentState state, String toolsSchema) {
    Map<String, String> vars = buildVars(req);
    StringBuilder system = new StringBuilder();

    // 1. base.system
    system.append(registry.render("base.system", vars));

    // 2. mode-specific
    if (req.mode() == Mode.chat) {
      system.append("\n\n").append(registry.render("chat.system", vars));
    } else {
      system.append("\n\n").append(registry.render("agent.system", vars));
    }

    // 3. tools.schema (agent only)
    if (req.mode() == Mode.agent && toolsSchema != null && !toolsSchema.isBlank()) {
      system.append("\n\n[Available tools]\n").append(toolsSchema);
    }

    // 4. compact.system (conditional)
    if (shouldCompact(req, state)) {
      system.append("\n\n").append(registry.render("compact.system", vars));
    }

    // 5. guard.system
    system.append("\n\n").append(registry.render("guard.system", vars));

    // 6. user-skill segments
    if (req.userSkills() != null && !req.userSkills().isEmpty()) {
      for (UserSkill skill : req.userSkills()) {
        if (skill.systemPrompt() != null && !skill.systemPrompt().isBlank()) {
          system.append("\n\n[USER_SKILL_BEGIN id=")
              .append(skill.id())
              .append(" version=")
              .append(skill.version())
              .append(" source=")
              .append(skill.source())
              .append(" scope=")
              .append(skill.scope() != null ? skill.scope() : "project")
              .append("]\n")
              .append(skill.systemPrompt())
              .append("\n[USER_SKILL_END]");
        }
      }
    }

    // Build messages
    List<Message> messages = new java.util.ArrayList<>();
    messages.add(new SystemMessage(system.toString()));

    // Prior conversation history (if any)
    if (state != null && state.history() != null) {
      messages.addAll(state.history());
    }

    // User message
    String userContent = budgeter.shapeUserMessage(req, state);
    messages.add(new UserMessage(userContent));

    return new Prompt(messages);
  }

  /**
   * Decides whether the current state warrants context compression (compact segment injection).
   *
   * <p>Triggers when:
   *
   * <ul>
   *   <li>Client explicitly sets {@code policy.requestCompact = true}
   *   <li>Estimated tokens > 70% of budget
   *   <li>Agent steps > 12
   * </ul>
   */
  public boolean shouldCompact(ConversationRequest req, AgentState state) {
    if (req.policy() != null && Boolean.TRUE.equals(req.policy().requestCompact())) {
      return true;
    }
    if (state != null) {
      int budget =
          req.policy() != null && req.policy().contextBudgetTokens() != null
              ? req.policy().contextBudgetTokens()
              : 100_000;
      if (state.estimatedTokens() > budget * 0.7) {
        return true;
      }
      if (state.steps() > 12) {
        return true;
      }
    }
    return false;
  }

  private Map<String, String> buildVars(ConversationRequest req) {
    Map<String, String> vars = new LinkedHashMap<>();
    vars.put("userLocale", "zh-CN");
    vars.put("mode", req.mode().name());

    // Infer language from contexts
    String language = "unknown";
    if (req.contexts() != null && !req.contexts().isEmpty()) {
      for (var ctx : req.contexts()) {
        if (ctx.language() != null && !ctx.language().isBlank()) {
          language = ctx.language();
          break;
        }
      }
    }
    vars.put("language", language);

    return vars;
  }

  /**
   * Mutable state carried across agent loop iterations within a single SSE run. Not persisted —
   * lives only in memory for the duration of the Flux.
   */
  public static class AgentState {

    private List<Message> history;
    private int steps;
    private long estimatedTokens;
    private String lastPlanDigest;
    private String lastAssistantTurnSummary;
    private int consecutiveFailures;

    public AgentState() {
      this.history = List.of();
      this.steps = 0;
      this.estimatedTokens = 0;
      this.consecutiveFailures = 0;
    }

    public List<Message> history() {
      return history;
    }

    public void setHistory(List<Message> history) {
      this.history = history;
    }

    public int steps() {
      return steps;
    }

    public void incrementSteps() {
      this.steps++;
    }

    public long estimatedTokens() {
      return estimatedTokens;
    }

    public void setEstimatedTokens(long tokens) {
      this.estimatedTokens = tokens;
    }

    public String lastPlanDigest() {
      return lastPlanDigest;
    }

    public void setLastPlanDigest(String digest) {
      this.lastPlanDigest = digest;
    }

    public String lastAssistantTurnSummary() {
      return lastAssistantTurnSummary;
    }

    public void setLastAssistantTurnSummary(String summary) {
      this.lastAssistantTurnSummary = summary;
    }

    public int consecutiveFailures() {
      return consecutiveFailures;
    }

    public void incrementConsecutiveFailures() {
      this.consecutiveFailures++;
    }

    public void resetConsecutiveFailures() {
      this.consecutiveFailures = 0;
    }
  }
}
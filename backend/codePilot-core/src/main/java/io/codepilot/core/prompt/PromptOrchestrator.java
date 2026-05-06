package io.codepilot.core.prompt;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.dto.ConversationMode;
import io.codepilot.core.skill.ActivatedSkill;
import java.util.ArrayList;
import java.util.List;
import org.apache.commons.lang3.StringUtils;
import org.springframework.stereotype.Service;

/**
 * Composes the final system message sent to the LLM by concatenating the skeleton segments and any
 * activated Skill bodies (user Skills are wrapped in explicit begin/end markers).
 *
 * <p>This component never returns the raw system text to API callers; it is consumed only inside
 * the ConversationService.
 */
@Service
public class PromptOrchestrator {

  private final PromptRegistry registry;
  private final ObjectMapper mapper;

  public PromptOrchestrator(PromptRegistry registry, ObjectMapper mapper) {
    this.registry = registry;
    this.mapper = mapper;
  }

  public Assembled assemble(AssembleRequest req) {
    List<String> segments = new ArrayList<>();
    segments.add(registry.get("base.system"));

    if (req.mode() == ConversationMode.AGENT) {
      segments.add(registry.get("agent.system"));
      segments.add(renderTools(req.toolsSchemaJson()));
      if (req.requestCompact()) segments.add(registry.get("agent.compact"));
      if (req.replanHint()) segments.add(registry.get("agent.replan"));
      if (req.hasUserPlanEdits()) {
        segments.add(renderUserEdits(req.userPlanEditsJson()));
      }
      if (req.hasLastToolResult()) segments.add(registry.get("agent.selfCheck"));
      segments.add(renderContextBudget(req.contextBudgetTokens()));
      segments.add(registry.get("agent.needsInput"));
      if (req.anyRiskyToolAvailable()) segments.add(registry.get("agent.riskNotice"));
      if (req.priorTurnFailed()) segments.add(registry.get("agent.repairLoop"));
      if (req.resuming()) segments.add(registry.get("agent.resume"));
      if (req.approachingDelivery()) segments.add(registry.get("agent.delivery"));
    } else {
      segments.add(registry.get("chat.system"));
    }

    for (ActivatedSkill skill : req.activatedSkills()) {
      segments.add(wrapSkill(skill));
    }

    segments.add(registry.get("guard.system"));

    String system = String.join("\n\n", segments).replace("{{userLocale}}", req.userLocale());
    return new Assembled(system, List.copyOf(req.activatedSkills()));
  }

  private String renderTools(String toolsSchemaJson) {
    String body = registry.get("agent.tools");
    return body.replace("{{toolsJsonSchema}}", toolsSchemaJson);
  }

  private String renderUserEdits(String editsJson) {
    return registry.get("agent.userEdits").replace("{{userPlanEdits}}", editsJson);
  }

  private String renderContextBudget(int budget) {
    return registry
        .get("agent.contextBudget")
        .replace("{{contextBudgetTokens}}", String.valueOf(budget));
  }

  private String wrapSkill(ActivatedSkill skill) {
    String header =
        "[USER_SKILL_BEGIN id="
            + skill.id()
            + " version="
            + skill.version()
            + " source="
            + skill.source()
            + " scope="
            + skill.scope()
            + "]";
    String footer = "[USER_SKILL_END]";
    return header + "\n" + skill.systemPrompt() + "\n" + footer;
  }

  public Assembled assembleForRequest(
      ConversationRunRequest req, List<ActivatedSkill> activated, String toolsSchemaJson) {
    boolean hasEdits = req.userPlanEdits() != null && !req.userPlanEdits().isEmpty();
    boolean hasLastToolResult =
        req.completedToolCallsTail() != null && !req.completedToolCallsTail().isEmpty();
    int budget =
        req.policy() != null && req.policy().contextBudgetTokens() != null
            ? req.policy().contextBudgetTokens()
            : 24_000;
    boolean requestCompact =
        req.policy() != null && "true".equalsIgnoreCase(req.policy().requestCompact());
    boolean replanHint = req.policy() != null && Boolean.TRUE.equals(req.policy().replanHint());
    boolean resuming =
        req.intent() == ConversationRunRequest.Intent.CONTINUE
            || req.intent() == ConversationRunRequest.Intent.ANSWER;
    String locale =
        req.options() != null && StringUtils.isNotBlank(req.options().locale())
            ? req.options().locale()
            : "zh-CN";
    return assemble(
        new AssembleRequest(
            req.mode(),
            toolsSchemaJson,
            requestCompact,
            replanHint,
            hasEdits,
            editsJson(req),
            hasLastToolResult,
            budget,
            true,
            false,
            resuming,
            false,
            activated,
            locale));
  }

  private String editsJson(ConversationRunRequest req) {
    try {
      return mapper.writeValueAsString(req.userPlanEdits());
    } catch (JsonProcessingException e) {
      return "[]";
    }
  }

  /** Internal request bag for deterministic wiring. */
  public record AssembleRequest(
      ConversationMode mode,
      String toolsSchemaJson,
      boolean requestCompact,
      boolean replanHint,
      boolean hasUserPlanEdits,
      String userPlanEditsJson,
      boolean hasLastToolResult,
      int contextBudgetTokens,
      boolean anyRiskyToolAvailable,
      boolean priorTurnFailed,
      boolean resuming,
      boolean approachingDelivery,
      List<ActivatedSkill> activatedSkills,
      String userLocale) {}

  /** Assembled result; the body is internal and never written to logs verbatim. */
  public record Assembled(String systemText, List<ActivatedSkill> activatedSkills) {}
}
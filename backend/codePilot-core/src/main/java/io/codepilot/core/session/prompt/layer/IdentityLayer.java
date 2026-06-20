package io.codepilot.core.session.prompt.layer;

import io.codepilot.core.agent.AgentDefinition;
import io.codepilot.core.agent.AgentRegistry;
import io.codepilot.core.session.prompt.PromptContext;
import io.codepilot.core.session.prompt.PromptLayer;
import io.codepilot.core.session.prompt.PromptResourceLoader;
import org.springframework.stereotype.Component;

/**
 * Identity layer — establishes the agent's identity and loads the active agent's behavior prompt
 * (build/plan/compose/subagent) from its configured prompt resource.
 *
 * <p>The base CodePilot identity + safety guardrails always come first; the agent-specific behavior
 * prompt (from {@link AgentDefinition#promptResource()} or an inline {@link
 * AgentDefinition#prompt()}) is appended below it. This is how the three behavior modes (and every
 * hidden subagent) acquire their distinct behavior.
 *
 * <p>Priority: 0 (first in the prompt).
 */
@Component
public class IdentityLayer implements PromptLayer {

  private static final String BASE_IDENTITY =
      """
You are CodePilot, an interactive AI coding agent that helps users with software engineering tasks.
Use the instructions and tools available to you to assist the user.

IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming.
IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes.
IMPORTANT: You MUST respond in the same language that the user writes in. If the user writes in Chinese, you MUST respond in Chinese. If the user writes in English, respond in English. If the user writes in any other language, respond in that language. Always match the user's language exactly — this applies to all your text output including explanations, comments, and tool call descriptions.""";

  private final AgentRegistry agentRegistry;
  private final PromptResourceLoader promptLoader;

  public IdentityLayer(AgentRegistry agentRegistry, PromptResourceLoader promptLoader) {
    this.agentRegistry = agentRegistry;
    this.promptLoader = promptLoader;
  }

  @Override
  public int priority() {
    return 0;
  }

  @Override
  public String build(PromptContext ctx) {
    String agentName = ctx.session().getCurrentAgent();
    AgentDefinition agent = agentRegistry.resolve(agentName);

    StringBuilder sb = new StringBuilder(BASE_IDENTITY);
    sb.append("\n\n## Active mode: ").append(agent.name());
    if (agent.description() != null && !agent.description().isBlank()) {
      sb.append(" — ").append(agent.description());
    }

    // Inject explicit language preference if available
    String lang = ctx.session().getLanguage();
    if (lang != null && !lang.isBlank() && !"en".equalsIgnoreCase(lang)) {
      String langName = switch (lang.toLowerCase()) {
        case "zh", "zh-cn", "zh-tw", "zh-hans", "zh-hant" -> "Chinese";
        case "ja" -> "Japanese";
        case "ko" -> "Korean";
        case "fr" -> "French";
        case "de" -> "German";
        case "es" -> "Spanish";
        case "pt" -> "Portuguese";
        case "ru" -> "Russian";
        case "ar" -> "Arabic";
        default -> lang;
      };
      sb.append("\n\n**Language requirement**: The user's preferred language is **").append(langName)
          .append("**. You MUST respond in ").append(langName)
          .append(". Do NOT respond in English unless the user explicitly writes in English.");
    }

    String behavior = resolveBehaviorPrompt(agent);
    if (behavior != null && !behavior.isBlank()) {
      sb.append("\n\n").append(behavior);
    }
    return sb.toString();
  }

  private String resolveBehaviorPrompt(AgentDefinition agent) {
    if (agent.prompt() != null && !agent.prompt().isBlank()) {
      return agent.prompt();
    }
    if (agent.promptResource() != null && !agent.promptResource().isBlank()) {
      return promptLoader.load(agent.promptResource()).orElse(null);
    }
    return null;
  }
}

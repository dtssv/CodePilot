package io.codepilot.core.agent;

import io.codepilot.core.agent.goal.GoalJudge;
import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.permission.PermissionEngine;
import io.codepilot.core.session.SessionState;
import io.codepilot.core.session.checkpoint.CheckpointWriter;
import io.codepilot.core.session.context.ContextBudget;
import io.codepilot.core.session.context.ContextCompactor;
import io.codepilot.core.session.prompt.PromptBuilder;
import io.codepilot.core.session.result.ToolResultSanitizer;
import io.codepilot.core.session.tool.ToolRegistry;
import org.springframework.stereotype.Component;

@Component
public class AgentLoopFactory {

  private final ChatClientFactory chatClientFactory;
  private final PromptBuilder promptBuilder;
  private final ContextBudget contextBudget;
  private final ContextCompactor contextCompactor;
  private final ToolRegistry toolRegistry;
  private final GoalJudge goalJudge;
  private final CheckpointWriter checkpointWriter;
  private final ToolResultSanitizer resultSanitizer;
  private final AgentRegistry agentRegistry;
  private final PermissionEngine permissionEngine;

  public AgentLoopFactory(
      ChatClientFactory chatClientFactory,
      PromptBuilder promptBuilder,
      ContextBudget contextBudget,
      ContextCompactor contextCompactor,
      ToolRegistry toolRegistry,
      GoalJudge goalJudge,
      CheckpointWriter checkpointWriter,
      ToolResultSanitizer resultSanitizer,
      AgentRegistry agentRegistry,
      PermissionEngine permissionEngine) {
    this.chatClientFactory = chatClientFactory;
    this.promptBuilder = promptBuilder;
    this.contextBudget = contextBudget;
    this.contextCompactor = contextCompactor;
    this.toolRegistry = toolRegistry;
    this.goalJudge = goalJudge;
    this.checkpointWriter = checkpointWriter;
    this.resultSanitizer = resultSanitizer;
    this.agentRegistry = agentRegistry;
    this.permissionEngine = permissionEngine;
  }

  /** Create an AgentLoop for the primary agent (build/plan/compose). */
  public AgentLoop create(SessionState session) {
    return create(session, session.getCurrentAgent());
  }

  /** Create an AgentLoop for a specific agent by name. */
  public AgentLoop create(SessionState session, String agentName) {
    AgentDefinition agent = agentRegistry.resolve(agentName);
    return new AgentLoop(
        session,
        chatClientFactory,
        promptBuilder,
        contextBudget,
        contextCompactor,
        toolRegistry,
        goalJudge,
        checkpointWriter,
        resultSanitizer,
        agent,
        permissionEngine);
  }
}

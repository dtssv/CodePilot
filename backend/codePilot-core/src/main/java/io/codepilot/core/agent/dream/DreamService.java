package io.codepilot.core.agent.dream;

import io.codepilot.core.agent.AgentDefinition;
import io.codepilot.core.agent.AgentLoop;
import io.codepilot.core.agent.AgentLoopFactory;
import io.codepilot.core.session.SessionState;
import io.codepilot.core.session.StreamEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Dream service — scans recent session traces and extracts persistent knowledge
 * into project memory, removing outdated entries.
 *
 * <p>dream command which spawns a hidden subagent
 * with read + memory write permissions.
 */
@Service
public class DreamService {

  private static final Logger log = LoggerFactory.getLogger(DreamService.class);

  private final AgentLoopFactory loopFactory;

  public DreamService(AgentLoopFactory loopFactory) {
    this.loopFactory = loopFactory;
  }

  /**
   * Run the dream subagent for a project.
   * The dream agent will: read recent session traces, extract persistent knowledge,
   * write to project memory, and remove outdated entries.
   *
   * @param userId    The user ID
   * @param projectId The project identifier
   * @return A flux of stream events from the dream agent
   */
  public Flux<StreamEvent> dream(String userId, String projectId) {
    log.info("Starting dream for user={} project={}", userId, projectId);

    SessionState session = new SessionState(
        "dream_" + java.util.UUID.randomUUID().toString().substring(0, 8),
        userId, "default-model");
    session.setGoalCondition("Analyze recent session traces for this project, extract persistent knowledge into project memory, and remove outdated entries. Focus on: project architecture, coding patterns, key decisions, frequently used commands.");
    session.addUserMessage("Run the dream process for project: " + projectId
        + ". Read recent session history, extract durable knowledge, and update project memory.");

    AgentLoop loop = loopFactory.create(session, "dream");
    return loop.run();
  }
}

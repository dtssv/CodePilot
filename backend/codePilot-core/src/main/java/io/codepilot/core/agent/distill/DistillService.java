package io.codepilot.core.agent.distill;

import io.codepilot.core.agent.AgentLoop;
import io.codepilot.core.agent.AgentLoopFactory;
import io.codepilot.core.session.SessionState;
import io.codepilot.core.session.StreamEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

/**
 * Distill service — discovers repeated manual workflows in recent work and
 * packages high-confidence candidates into reusable skills.
 *
 * <p>distill command which spawns a hidden subagent
 * with read + write + memory permissions.
 */
@Service
public class DistillService {

  private static final Logger log = LoggerFactory.getLogger(DistillService.class);

  private final AgentLoopFactory loopFactory;

  public DistillService(AgentLoopFactory loopFactory) {
    this.loopFactory = loopFactory;
  }

  /**
   * Run the distill subagent for a project.
   * The distill agent will: analyze recent work patterns, identify repeated
   * manual workflows, and package them into reusable skills.
   *
   * @param userId    The user ID
   * @param projectId The project identifier
   * @return A flux of stream events from the distill agent
   */
  public Flux<StreamEvent> distill(String userId, String projectId) {
    log.info("Starting distill for user={} project={}", userId, projectId);

    SessionState session = new SessionState(
        "distill_" + java.util.UUID.randomUUID().toString().substring(0, 8),
        userId, userId);
    session.setGoalCondition("Analyze recent work patterns for this project and identify repeated manual workflows. Package high-confidence candidates into reusable skills. Each skill should have a name, description, and step-by-step instructions.");
    session.addUserMessage("Run the distill process for project: " + projectId
        + ". Analyze recent sessions, find repeated patterns, and generate skill definitions.");

    AgentLoop loop = loopFactory.create(session, "distill");
    return loop.run();
  }
}

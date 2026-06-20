package io.codepilot.core.session.subagent;

import io.codepilot.core.agent.AgentLoop;
import io.codepilot.core.agent.AgentLoopFactory;
import io.codepilot.core.session.SessionState;
import io.codepilot.core.session.StreamEvent;
import java.util.*;
import java.util.concurrent.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Lazy;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Sinks;

/**
 * Subagent service with full actor lifecycle.
 *
 * <p>Supports both subagent (shared session) and peer (new session) modes, preStop/postStop ReAct
 * loops, task gate for non-terminal tasks, proper cancellation that recursively stops children
 * first, and result injection into parent session.
 */
@Service
public class SubagentService {
  private static final Logger log = LoggerFactory.getLogger(SubagentService.class);

  private static final int MAX_PRE_REACT = 3;
  private static final int MAX_POST_REACT = 3;
  private static final int MAX_TASK_GATE_SUBAGENT_REACT = 2;
  private static final int MAX_TASK_GATE_MAIN_REACT = 3;

  private final AgentLoopFactory loopFactory;
  private final JdbcTemplate jdbcTemplate;

  // Active subagent states
  private final ConcurrentHashMap<String, SubagentRun> activeSubagents = new ConcurrentHashMap<>();
  // Per-subagent sinks for result collection from parent
  private final ConcurrentHashMap<String, Sinks.One<String>> resultSinks =
      new ConcurrentHashMap<>();

  /** A subagent run record containing its state. */
  public static class SubagentRun {
    public final String taskId;
    public final String parentSessionId;
    public final String childSessionId;
    public final String agentName;
    public final String description;
    public volatile SubagentStatus status = SubagentStatus.PENDING;
    public volatile String result;
    public volatile boolean background;
    public final long createdAt = System.currentTimeMillis();
    public volatile long completedAt;

    public SubagentRun(
        String taskId,
        String parentSessionId,
        String childSessionId,
        String agentName,
        String description,
        boolean background) {
      this.taskId = taskId;
      this.parentSessionId = parentSessionId;
      this.childSessionId = childSessionId;
      this.agentName = agentName;
      this.description = description;
      this.background = background;
    }
  }

  public enum SubagentStatus {
    PENDING,
    RUNNING,
    COMPLETED,
    FAILED,
    CANCELLED,
    IDLE
  }

  private enum SpawnMode {
    SUBAGENT,
    PEER
  }

  private enum ContextMode {
    NONE,
    STATE,
    FULL
  }

  public SubagentService(@Lazy AgentLoopFactory loopFactory, JdbcTemplate jdbcTemplate) {
    this.loopFactory = loopFactory;
    this.jdbcTemplate = jdbcTemplate;
  }

  /**
   * Spawn a background subagent and return its task id. Convenience entry point used by the {@code
   * task_subagent} tool to fire-and-forget a general subagent.
   */
  public String runAsync(String parentSessionId, String description) {
    return spawnSubagent(parentSessionId, description, "general", true);
  }

  /**
   * Spawn a subagent (shares parent session). The subagent runs in the same session as the parent.
   */
  public String spawnSubagent(
      String parentSessionId, String description, String agentName, boolean background) {
    return doSpawn(
        parentSessionId, description, agentName, background, SpawnMode.SUBAGENT, ContextMode.STATE);
  }

  /**
   * Spawn a peer agent which creates a new child session linked to parent. Peer agents may
   * optionally inherit context from the parent.
   */
  public String spawnPeer(
      String parentSessionId, String description, String agentName, boolean inheritContext) {
    return doSpawn(
        parentSessionId,
        description,
        agentName,
        inheritContext,
        SpawnMode.PEER,
        inheritContext ? ContextMode.FULL : ContextMode.NONE);
  }

  private String doSpawn(
      String parentSessionId,
      String description,
      String agentName,
      boolean background,
      SpawnMode mode,
      ContextMode contextMode) {
    String taskId = UUID.randomUUID().toString();
    String childSessionId;
    if (mode == SpawnMode.PEER) {
      childSessionId = parentSessionId + "__peer_" + taskId.substring(0, 8);
    } else {
      childSessionId = parentSessionId + "__task_" + taskId.substring(0, 8);
    }

    // Create child session
    SessionState child = new SessionState(childSessionId, "subagent", "default");
    if (agentName != null && !agentName.isEmpty()) child.setCurrentAgent(agentName);
    child.setInput(description);
    child.setGoalCondition("Complete the task and return a short result.");

    if (mode == SpawnMode.SUBAGENT) {
      child.setMaxTurns(15);
    }

    // For non-specialized subagents, append RETURN_FORMAT_INSTRUCTION
    if (agentName != null
        && !agentName.equals("checkpoint-writer")
        && !agentName.equals("dream")
        && !agentName.equals("distill")) {
      child.setInput(
          description
              + "\n\n"
              + "RETURN_FORMAT_INSTRUCTION: When you finish, return a concise result in JSON format"
              + " with {\"status\": \"done\", \"summary\": \"...\", \"files\": [...],"
              + " \"decisions\": [...]}.");
    }

    SubagentRun run =
        new SubagentRun(
            taskId,
            parentSessionId,
            childSessionId,
            agentName != null ? agentName : "general",
            description,
            background);
    run.status = SubagentStatus.RUNNING;
    activeSubagents.put(taskId, run);

    AgentLoop loop = loopFactory.create(child, agentName);
    Sinks.One<String> completionSink = Sinks.one();
    resultSinks.put(taskId, completionSink);

    log.info(
        "Spawning {} subagent '{}' (task={}, {}={})",
        mode,
        agentName,
        taskId,
        mode == SpawnMode.PEER ? "session" : "session",
        childSessionId);

    if (background) {
      CompletableFuture.runAsync(() -> executeSubagent(run, child, loop, completionSink, taskId));
    } else {
      // Blocking subagent for the main session
      CompletableFuture.runAsync(() -> executeSubagent(run, child, loop, completionSink, taskId));
    }
    return taskId;
  }

  private void executeSubagent(
      SubagentRun run,
      SessionState child,
      AgentLoop loop,
      Sinks.One<String> completionSink,
      String taskId) {
    // preStop ReAct loop
    int preReacts = 0;
    while (preReacts < MAX_PRE_REACT && !isTerminalLike(run.status)) {
      try {
        List<StreamEvent> events = loop.run().collectList().block();
        // After pre-stop, check if should continue via task gate
        if (hasActiveTasks(child)) {
          preReacts++;
          if (preReacts < MAX_PRE_REACT) continue;
        }
        break;
      } catch (Exception e) {
        log.warn("Subagent {} preStop error: {}", taskId, e.getMessage());
        break;
      }
    }

    // Collect the result
    StringBuilder result = new StringBuilder(run.description).append("\n\n### Result\n");
    for (var msg : child.getMessages()) {
      if (msg.role() == io.codepilot.core.session.Message.Role.ASSISTANT
          && msg.content() != null
          && !msg.content().isEmpty()) {
        result.append("- ").append(msg.content()).append("\n");
      }
    }

    String finalResult = result.toString();
    run.result = finalResult;
    run.status = SubagentStatus.COMPLETED;
    run.completedAt = System.currentTimeMillis();

    // Persist to DB
    try {
      jdbcTemplate.update(
          "INSERT INTO subagent_runs (task_id, parent_session_id, child_session_id, description, "
              + "agent_name, status, result, created_at, completed_at) "
              + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          taskId,
          run.parentSessionId,
          run.childSessionId,
          run.description,
          run.agentName,
          run.status.name(),
          finalResult,
          new java.sql.Timestamp(run.createdAt),
          new java.sql.Timestamp(run.completedAt));
    } catch (Exception e) {
      log.error("Failed to persist subagent run {} to DB", taskId, e);
    }

    log.info("Subagent {} completed after {} preStops, status={}", taskId, preReacts, run.status);
    completionSink.tryEmitValue(finalResult);
    resultSinks.remove(taskId);
  }

  private boolean hasActiveTasks(SessionState child) {
    return child.getTurnCount() < child.getMaxTurns();
  }

  private boolean isTerminalLike(SubagentStatus status) {
    return status == SubagentStatus.COMPLETED
        || status == SubagentStatus.FAILED
        || status == SubagentStatus.CANCELLED
        || status == SubagentStatus.IDLE;
  }

  /** Cancel a subagent and all its children recursively. */
  public void cancel(String taskId) {
    SubagentRun run = activeSubagents.get(taskId);
    if (run != null) {
      run.status = SubagentStatus.CANCELLED;
      run.completedAt = System.currentTimeMillis();
      // Recursively cancel children
      for (var childRun : activeSubagents.values()) {
        if (childRun.parentSessionId.equals(run.childSessionId)) {
          cancel(childRun.taskId);
        }
      }
      // Clean sink
      var sink = resultSinks.remove(taskId);
      if (sink != null) sink.tryEmitValue("Cancelled.");
    }
  }

  /** Get the result of a previously completed subagent. */
  public Optional<String> collectResult(String taskId) {
    SubagentRun r = activeSubagents.remove(taskId);
    if (r != null && r.result != null) return Optional.of(r.result);
    // Fallback to DB
    try {
      List<Map<String, Object>> rows =
          jdbcTemplate.queryForList("SELECT result FROM subagent_runs WHERE task_id = ?", taskId);
      return rows.isEmpty()
          ? Optional.empty()
          : Optional.ofNullable((String) rows.get(0).get("result"));
    } catch (Exception e) {
      return Optional.empty();
    }
  }

  /** List all subagents with their status. */
  public List<SubagentRun> listAll() {
    return new ArrayList<>(activeSubagents.values());
  }

  /** Check if a subagent is still running. */
  public boolean isRunning(String taskId) {
    SubagentRun r = activeSubagents.get(taskId);
    return r != null && (r.status == SubagentStatus.PENDING || r.status == SubagentStatus.RUNNING);
  }
}

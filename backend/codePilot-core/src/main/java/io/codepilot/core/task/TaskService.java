package io.codepilot.core.task;

import java.time.Instant;
import java.util.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Task tracking service with tree-shaped task hierarchy. Task system integrated
 * with checkpointing.
 *
 * <p>Tasks form a tree within a session: T1, T1.1, T1.2, T2, etc. The stored ID
 * incorporates a session prefix to guarantee global uniqueness across sessions
 * (e.g. "s3a1b2c:T1"), while the display/prompt ID remains "T1".
 *
 * <p>Progress is persisted to DB and injected into the prompt.
 */
@Service
public class TaskService {

  private static final Logger log = LoggerFactory.getLogger(TaskService.class);

  private final JdbcTemplate jdbc;

  public TaskService(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  /** Create a new task. If parentId is null, it's a top-level task. */
  public TaskInfo create(String sessionId, String parentId, String title, String description) {
    String sessionPrefix = sessionPrefix(sessionId);
    int maxRetry = 5;
    for (int attempt = 0; attempt < maxRetry; attempt++) {
      int siblingCount = countSiblings(sessionId, parentId);
      String displayId = TaskInfo.generateId(parentId, siblingCount + 1);
      // Include session prefix in the stored ID to avoid collisions across sessions
      String storageId = sessionPrefix + ":" + displayId;
      String storageParentId = parentId != null ? sessionPrefix + ":" + parentId : null;
      Instant now = Instant.now();
      try {
        jdbc.update(
            "INSERT INTO agent_tasks (id, parent_id, session_id, title, description, status,"
                + " created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
            storageId,
            storageParentId,
            sessionId,
            title,
            description,
            java.sql.Timestamp.from(now),
            java.sql.Timestamp.from(now));
        log.debug("Created task {} (storage: {}) in session {}", displayId, storageId, sessionId);
        // Return TaskInfo with the display-friendly ID and parent ID
        return new TaskInfo(
            displayId, parentId, sessionId, title, description, TaskInfo.Status.PENDING, now, now);
      } catch (org.springframework.dao.DuplicateKeyException e) {
        log.warn(
            "Task ID {} already exists (attempt {}/{}), retrying with next ID",
            storageId, attempt + 1, maxRetry);
        if (attempt == maxRetry - 1) {
          throw e;
        }
      }
    }
    throw new IllegalStateException("Failed to create task after " + maxRetry + " retries");
  }

  /** Update task status. Returns empty if task not found. */
  public Optional<TaskInfo> update(String sessionId, String id, TaskInfo.Status status) {
    String storageId = sessionPrefix(sessionId) + ":" + id;
    int rows = jdbc.update(
        "UPDATE agent_tasks SET status = ?, updated_at = ? WHERE id = ?",
        status.name().toLowerCase(),
        java.sql.Timestamp.from(Instant.now()),
        storageId);
    if (rows == 0) {
      log.warn("Task update affected 0 rows: task {} not found in session {}", id, sessionId);
      return Optional.empty();
    }
    return get(sessionId, id);
  }

  /** Get a task by session ID and display ID. */
  public Optional<TaskInfo> get(String sessionId, String id) {
    String storageId = sessionPrefix(sessionId) + ":" + id;
    List<TaskInfo> results =
        jdbc.query(
            "SELECT * FROM agent_tasks WHERE id = ?",
            (rs, rowNum) -> {
              String storedId = rs.getString("id");
              String storedParentId = rs.getString("parent_id");
              return new TaskInfo(
                  stripPrefix(storedId),
                  stripPrefix(storedParentId),
                  rs.getString("session_id"),
                  rs.getString("title"),
                  rs.getString("description"),
                  TaskInfo.Status.valueOf(rs.getString("status").toUpperCase()),
                  rs.getTimestamp("created_at").toInstant(),
                  rs.getTimestamp("updated_at").toInstant());
            },
            storageId);
    return results.isEmpty() ? Optional.empty() : Optional.of(results.get(0));
  }

  /** List all tasks for a session. */
  public List<TaskInfo> list(String sessionId) {
    return jdbc.query(
        "SELECT * FROM agent_tasks WHERE session_id = ? ORDER BY id",
        (rs, rowNum) -> {
          String storedId = rs.getString("id");
          String storedParentId = rs.getString("parent_id");
          return new TaskInfo(
              stripPrefix(storedId),
              stripPrefix(storedParentId),
              rs.getString("session_id"),
              rs.getString("title"),
              rs.getString("description"),
              TaskInfo.Status.valueOf(rs.getString("status").toUpperCase()),
              rs.getTimestamp("created_at").toInstant(),
              rs.getTimestamp("updated_at").toInstant());
        },
        sessionId);
  }

  /** Format task tree for prompt injection. */
  public String formatForPrompt(String sessionId) {
    List<TaskInfo> tasks = list(sessionId);
    if (tasks.isEmpty()) return "";
    StringBuilder sb = new StringBuilder();
    sb.append("# Task Progress\n\n");
    for (TaskInfo task : tasks) {
      int depth = task.id().split("\\.").length - 1;
      String indent = "  ".repeat(depth);
      String icon =
          switch (task.status()) {
            case COMPLETED -> "[x]";
            case IN_PROGRESS -> "[~]";
            case FAILED -> "[!]";
            case PENDING -> "[ ]";
          };
      sb.append(indent)
          .append(icon)
          .append(" ")
          .append(task.id())
          .append(": ")
          .append(task.title());
      if (task.status() != TaskInfo.Status.PENDING) {
        sb.append(" (").append(task.status().name().toLowerCase()).append(")");
      }
      sb.append("\n");
    }
    return sb.toString();
  }

  /**
   * Generate a short, stable prefix from the session ID to make stored task IDs globally unique
   * while keeping them compact.
   */
  static String sessionPrefix(String sessionId) {
    if (sessionId == null || sessionId.isBlank()) return "s0";
    // Use first 8 hex chars of hashCode for compactness
    return "s" + Integer.toHexString(sessionId.hashCode());
  }

  /** Strip the session prefix from a stored ID to get the display ID (e.g. "T1"). */
  private static String stripPrefix(String storedId) {
    if (storedId == null) return null;
    int colon = storedId.indexOf(':');
    return colon >= 0 ? storedId.substring(colon + 1) : storedId;
  }

  private int countSiblings(String sessionId, String parentId) {
    String sessionPrefix = sessionPrefix(sessionId);
    Integer count =
        jdbc.queryForObject(
            "SELECT COUNT(*) FROM agent_tasks WHERE session_id = ? AND parent_id "
                + (parentId == null ? "IS NULL" : "= ?"),
            Integer.class,
            parentId == null
                ? new Object[] {sessionId}
                : new Object[] {sessionId, sessionPrefix + ":" + parentId});
    return count != null ? count : 0;
  }
}

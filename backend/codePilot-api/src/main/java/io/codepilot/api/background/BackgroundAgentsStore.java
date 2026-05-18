package io.codepilot.api.background;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Cloud background agent task registry.
 *
 * <p>Primary: {@code background_agent_tasks} (Flyway V9). Fallback: JSON file when DB unavailable.
 */
@Component
public class BackgroundAgentsStore {

  private static final Logger log = LoggerFactory.getLogger(BackgroundAgentsStore.class);

  private final ObjectMapper mapper = new ObjectMapper();
  private final NamedParameterJdbcTemplate jdbc;
  private final Path storageFile;
  private final String persistenceMode;
  private final Map<String, Map<String, Object>> fileTasks = new ConcurrentHashMap<>();
  private volatile boolean dbActive;

  public BackgroundAgentsStore(
      NamedParameterJdbcTemplate jdbc,
      @Value("${codepilot.background.persistence:auto}") String persistenceMode,
      @Value("${codepilot.background.storage-file:${java.io.tmpdir}/codepilot-bg/tasks.json}") String storageFile) {
    this.jdbc = jdbc;
    this.persistenceMode = persistenceMode != null ? persistenceMode.trim().toLowerCase() : "auto";
    this.storageFile = Path.of(storageFile);
  }

  @PostConstruct
  void init() {
    if ("file".equals(persistenceMode)) {
      dbActive = false;
      loadFileSnapshot();
      log.info("Background agents persistence: file ({})", storageFile);
      return;
    }
    if (probeDb()) {
      dbActive = true;
      importFileIfDbEmpty();
      log.info("Background agents persistence: database");
    } else {
      dbActive = false;
      loadFileSnapshot();
      log.warn("Background agents persistence: file fallback ({})", storageFile);
    }
  }

  public boolean isDbBacked() {
    return dbActive;
  }

  public Map<String, Map<String, Object>> all() {
    if (dbActive) {
      Map<String, Map<String, Object>> out = new LinkedHashMap<>();
      for (Map<String, Object> task : loadAllFromDb()) {
        String id = stringVal(task, "id", null);
        if (id != null) out.put(id, task);
      }
      return out;
    }
    return Map.copyOf(fileTasks);
  }

  public Map<String, Object> get(String id) {
    if (dbActive) {
      return loadOneFromDb(id);
    }
    return fileTasks.get(id);
  }

  public void put(String id, Map<String, Object> task) {
    Map<String, Object> copy = new LinkedHashMap<>(task);
    copy.put("id", id);
    if (dbActive) {
      upsertDb(id, copy);
      return;
    }
    fileTasks.put(id, copy);
    persistFile();
  }

  public Map<String, Object> remove(String id) {
    if (dbActive) {
      Map<String, Object> existing = loadOneFromDb(id);
      if (existing == null) return null;
      jdbc.update("DELETE FROM background_agent_tasks WHERE id = :id", Map.of("id", id));
      return existing;
    }
    Map<String, Object> removed = fileTasks.remove(id);
    if (removed != null) persistFile();
    return removed;
  }

  private boolean probeDb() {
    if ("file".equals(persistenceMode)) return false;
    try {
      jdbc.queryForObject("SELECT COUNT(*) FROM background_agent_tasks", Map.of(), Integer.class);
      return true;
    } catch (DataAccessException e) {
      return false;
    }
  }

  private void importFileIfDbEmpty() {
    try {
      Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM background_agent_tasks", Map.of(), Integer.class);
      if (count != null && count > 0) return;
      if (!Files.exists(storageFile)) return;
      Map<String, Map<String, Object>> loaded =
          mapper.readValue(Files.readAllBytes(storageFile), new TypeReference<>() {});
      loaded.forEach(this::put);
      log.info("Imported {} background tasks from file into database", loaded.size());
    } catch (Exception e) {
      log.warn("Background file import skipped: {}", e.getMessage());
    }
  }

  private void upsertDb(String id, Map<String, Object> task) {
    String status = stringVal(task, "status", "queued");
    String title = stringVal(task, "title", "Background task");
    String prompt = stringVal(task, "prompt", "");
    String worktree = stringVal(task, "worktreePath", null);
    String localId = stringVal(task, "localTaskId", null);
    String branch = stringVal(task, "branchName", null);
    String endedAt = stringVal(task, "endedAt", null);
    String taskJson;
    try {
      taskJson = mapper.writeValueAsString(task);
    } catch (Exception e) {
      taskJson = "{}";
    }
    jdbc.update("DELETE FROM background_agent_tasks WHERE id = :id", Map.of("id", id));
    jdbc.update(
        """
        INSERT INTO background_agent_tasks (
            id, status, title, prompt, worktree_path, local_task_id, branch_name,
            task_json, ended_at)
        VALUES (
            :id, :status, :title, :prompt, :worktreePath, :localTaskId, :branchName,
            :taskJson, :endedAt)
        """,
        new MapSqlParameterSource()
            .addValue("id", id)
            .addValue("status", status)
            .addValue("title", title)
            .addValue("prompt", prompt)
            .addValue("worktreePath", worktree)
            .addValue("localTaskId", localId)
            .addValue("branchName", branch)
            .addValue("taskJson", taskJson)
            .addValue("endedAt", parseInstantOrNull(endedAt)));
  }

  private java.util.List<Map<String, Object>> loadAllFromDb() {
    return jdbc.query(
        """
        SELECT id, status, title, prompt, worktree_path, local_task_id, branch_name,
               task_json, created_at, updated_at, ended_at
        FROM background_agent_tasks
        ORDER BY updated_at DESC
        """,
        Map.of(),
        (rs, rowNum) -> rowToTask(rs.getString("id"), rs.getString("task_json")));
  }

  private Map<String, Object> loadOneFromDb(String id) {
    return jdbc.query(
        """
        SELECT id, task_json FROM background_agent_tasks WHERE id = :id
        """,
        Map.of("id", id),
        (rs, rowNum) -> rowToTask(rs.getString("id"), rs.getString("task_json")))
        .stream()
        .findFirst()
        .orElse(null);
  }

  private Map<String, Object> rowToTask(String id, String taskJson) {
    try {
      Map<String, Object> task = mapper.readValue(taskJson, new TypeReference<>() {});
      task.put("id", id);
      return task;
    } catch (Exception e) {
      return Map.of("id", id, "status", "queued");
    }
  }

  private void loadFileSnapshot() {
    try {
      if (!Files.exists(storageFile)) return;
      Map<String, Map<String, Object>> loaded =
          mapper.readValue(Files.readAllBytes(storageFile), new TypeReference<>() {});
      fileTasks.clear();
      fileTasks.putAll(loaded);
    } catch (Exception e) {
      log.warn("Failed to load background tasks file: {}", e.getMessage());
    }
  }

  private void persistFile() {
    try {
      Files.createDirectories(storageFile.getParent());
      mapper.writerWithDefaultPrettyPrinter().writeValue(storageFile.toFile(), fileTasks);
    } catch (Exception e) {
      log.warn("Failed to persist background tasks file: {}", e.getMessage());
    }
  }

  private static String stringVal(Map<String, Object> m, String key, String defaultVal) {
    Object v = m.get(key);
    return v != null ? String.valueOf(v) : defaultVal;
  }

  private static java.sql.Timestamp parseInstantOrNull(String iso) {
    if (iso == null || iso.isBlank()) return null;
    try {
      return java.sql.Timestamp.from(Instant.parse(iso));
    } catch (Exception e) {
      return null;
    }
  }
}

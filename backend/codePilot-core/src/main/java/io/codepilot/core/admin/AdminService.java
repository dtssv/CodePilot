package io.codepilot.core.admin;

import io.codepilot.common.api.CodePilotException;
import io.codepilot.common.api.ErrorCodes;
import io.codepilot.core.model.ModelGroup;
import io.codepilot.core.model.ModelService;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.ReactiveRedisTemplate;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Admin service providing session, user, and model management operations. Data sources: PostgreSQL
 * (audit_events, model_groups, custom_model_providers) + Redis (session metadata).
 */
@Service
public class AdminService {

  private static final Logger log = LoggerFactory.getLogger(AdminService.class);

  private final NamedParameterJdbcTemplate jdbc;
  private final ReactiveRedisTemplate<String, String> redisTemplate;
  private final ModelService modelService;

  public AdminService(
      NamedParameterJdbcTemplate jdbc,
      ReactiveRedisTemplate<String, String> redisTemplate,
      ModelService modelService) {
    this.jdbc = jdbc;
    this.redisTemplate = redisTemplate;
    this.modelService = modelService;
  }

  // ==================== Session Management ====================

  /** List sessions with pagination and filters. */
  public Map<String, Object> listSessions(
      int page, int size, String userId, String keyword, String startTime, String endTime) {
    StringBuilder where = new StringBuilder("WHERE 1=1");
    MapSqlParameterSource params = new MapSqlParameterSource();

    if (userId != null && !userId.isBlank()) {
      where.append(" AND actor = :userId");
      params.addValue("userId", userId);
    }
    if (keyword != null && !keyword.isBlank()) {
      where.append(" AND session_id LIKE :keyword");
      params.addValue("keyword", "%" + keyword + "%");
    }
    if (startTime != null && !startTime.isBlank()) {
      where.append(" AND created_at >= CAST(:startTime AS DATETIME)");
      params.addValue("startTime", startTime);
    }
    if (endTime != null && !endTime.isBlank()) {
      where.append(" AND created_at <= CAST(:endTime AS DATETIME)");
      params.addValue("endTime", endTime);
    }

    // Count total
    String countSql = "SELECT COUNT(DISTINCT session_id) FROM audit_events " + where;
    Long total = jdbc.queryForObject(countSql, params, Long.class);
    if (total == null) total = 0L;

    // Query distinct sessions with pagination
    String dataSql =
        """
        SELECT session_id, actor, MIN(created_at) AS created_at,
               COUNT(*) AS event_count
        FROM audit_events
        """
            + where
            + """
              GROUP BY session_id, actor
              ORDER BY MIN(created_at) DESC
              LIMIT :limit OFFSET :offset
              """;
    params.addValue("limit", size);
    params.addValue("offset", (page - 1) * size);

    List<Map<String, Object>> sessions = jdbc.queryForList(dataSql, params);

    // Enrich with token usage from Redis if available
    for (Map<String, Object> session : sessions) {
      String sessionId = (String) session.get("session_id");
      try {
        var entries =
            redisTemplate
                .opsForHash()
                .entries("codepilot:session:" + sessionId)
                .collectList()
                .block();
        Map<String, String> meta;
        if (entries != null) {
          meta = new HashMap<>();
          for (var entry : entries) {
            meta.put((String) entry.getKey(), (String) entry.getValue());
          }
        } else {
          meta = new HashMap<>();
        }
        session.put("tokenUsage", parseLong(meta.getOrDefault("tokenUsage", "0")));
        session.put("status", meta.getOrDefault("status", "unknown"));
        session.put("title", meta.getOrDefault("title", ""));
      } catch (Exception e) {
        session.put("tokenUsage", 0L);
        session.put("status", "unknown");
        session.put("title", "");
      }
    }

    Map<String, Object> result = new HashMap<>();
    result.put("items", sessions);
    result.put("total", total);
    result.put("page", page);
    result.put("size", size);
    return result;
  }

  /** Get session detail including message history and tool call stats. */
  public Map<String, Object> getSessionDetail(String sessionId) {
    // Get audit events for this session
    String sql =
        """
        SELECT id, trace_id, action, actor, payload, created_at
        FROM audit_events
        WHERE session_id = :sessionId
        ORDER BY created_at ASC
        """;
    List<Map<String, Object>> events =
        jdbc.queryForList(sql, new MapSqlParameterSource("sessionId", sessionId));

    // Tool call statistics
    String toolSql =
        """
SELECT JSON_EXTRACT(payload, '$.toolName') AS tool_name,
       COUNT(*) AS call_count,
       SUM(CASE WHEN JSON_EXTRACT(payload, '$.ok') = true THEN 1 ELSE 0 END) AS success_count
FROM audit_events
WHERE session_id = :sessionId AND action = 'tool.execute'
GROUP BY JSON_EXTRACT(payload, '$.toolName')
""";
    List<Map<String, Object>> toolStats =
        jdbc.queryForList(toolSql, new MapSqlParameterSource("sessionId", sessionId));

    // Token usage from Redis
    long tokenUsage = 0;
    String status = "unknown";
    String title = "";
    try {
      var entries =
          redisTemplate
              .opsForHash()
              .entries("codepilot:session:" + sessionId)
              .collectList()
              .block();
      Map<String, String> meta;
      if (entries != null) {
        meta = new HashMap<>();
        for (var entry : entries) {
          meta.put((String) entry.getKey(), (String) entry.getValue());
        }
      } else {
        meta = new HashMap<>();
      }
      tokenUsage = parseLong(meta.getOrDefault("tokenUsage", "0"));
      status = meta.getOrDefault("status", "unknown");
      title = meta.getOrDefault("title", "");
    } catch (Exception ignored) {
    }

    Map<String, Object> result = new HashMap<>();
    result.put("sessionId", sessionId);
    result.put("title", title);
    result.put("status", status);
    result.put("tokenUsage", tokenUsage);
    result.put("events", events);
    result.put("toolCallStats", toolStats);
    return result;
  }

  /** Delete a session (remove from Redis + audit events). */
  public void deleteSession(String sessionId) {
    // Delete Redis keys
    try {
      redisTemplate.delete("codepilot:session:" + sessionId).block();
      redisTemplate.delete("codepilot:session:messages:" + sessionId).block();
    } catch (Exception e) {
      log.warn("Failed to delete Redis keys for session {}", sessionId, e);
    }
    // Delete audit events
    jdbc.update(
        "DELETE FROM audit_events WHERE session_id = :sessionId",
        new MapSqlParameterSource("sessionId", sessionId));
  }

  /** Get session statistics. */
  public Map<String, Object> getSessionStats() {
    String totalSql = "SELECT COUNT(DISTINCT session_id) FROM audit_events";
    Long totalSessions = jdbc.queryForObject(totalSql, new MapSqlParameterSource(), Long.class);

    String dauSql =
        """
        SELECT COUNT(DISTINCT session_id) FROM audit_events
        WHERE created_at >= CAST(:since AS DATETIME)
        """;
    String today = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.DAYS).toString();
    Long dau = jdbc.queryForObject(dauSql, new MapSqlParameterSource("since", today), Long.class);

    String avgTokenSql =
        """
        SELECT AVG(CAST(token_val AS BIGINT)) FROM (
            SELECT session_id, JSON_EXTRACT(payload, '$.durationMs') AS token_val
            FROM audit_events
            WHERE action = 'tool.execute' AND payload IS NOT NULL
        ) sub
        """;
    Double avgToken = null;
    try {
      avgToken = jdbc.queryForObject(avgTokenSql, new MapSqlParameterSource(), Double.class);
    } catch (Exception e) {
      avgToken = 0.0;
    }

    Map<String, Object> result = new HashMap<>();
    result.put("totalSessions", totalSessions != null ? totalSessions : 0);
    result.put("dailyActive", dau != null ? dau : 0);
    result.put("avgTokenUsage", avgToken != null ? Math.round(avgToken) : 0);
    return result;
  }

  // ==================== User Management ====================

  /** List users with pagination and search. */
  public Map<String, Object> listUsers(int page, int size, String keyword) {
    StringBuilder where = new StringBuilder("WHERE 1=1");
    MapSqlParameterSource params = new MapSqlParameterSource();

    if (keyword != null && !keyword.isBlank()) {
      where.append(" AND actor LIKE :keyword");
      params.addValue("keyword", "%" + keyword + "%");
    }

    String countSql = "SELECT COUNT(DISTINCT actor) FROM audit_events " + where;
    Long total = jdbc.queryForObject(countSql, params, Long.class);
    if (total == null) total = 0L;

    String dataSql =
        """
        SELECT actor AS user_id,
               COUNT(DISTINCT session_id) AS session_count,
               COUNT(*) AS event_count,
               MIN(created_at) AS first_seen,
               MAX(created_at) AS last_seen
        FROM audit_events
        """
            + where
            + """
              GROUP BY actor
              ORDER BY MAX(created_at) DESC
              LIMIT :limit OFFSET :offset
              """;
    params.addValue("limit", size);
    params.addValue("offset", (page - 1) * size);

    List<Map<String, Object>> users = jdbc.queryForList(dataSql, params);

    Map<String, Object> result = new HashMap<>();
    result.put("items", users);
    result.put("total", total);
    result.put("page", page);
    result.put("size", size);
    return result;
  }

  /** Get user detail. */
  public Map<String, Object> getUserDetail(String userId) {
    String sql =
        """
        SELECT actor AS user_id,
               COUNT(DISTINCT session_id) AS session_count,
               COUNT(*) AS event_count,
               MIN(created_at) AS first_seen,
               MAX(created_at) AS last_seen
        FROM audit_events
        WHERE actor = :userId
        GROUP BY actor
        """;
    List<Map<String, Object>> rows =
        jdbc.queryForList(sql, new MapSqlParameterSource("userId", userId));
    if (rows.isEmpty()) {
      throw new CodePilotException(ErrorCodes.NOT_FOUND, "User not found: " + userId);
    }
    Map<String, Object> user = rows.get(0);

    // Token usage estimate from audit events
    String tokenSql =
        """
        SELECT COUNT(*) AS tool_calls
        FROM audit_events
        WHERE actor = :userId AND action = 'tool.execute'
        """;
    Long toolCalls =
        jdbc.queryForObject(tokenSql, new MapSqlParameterSource("userId", userId), Long.class);
    user.put("toolCallCount", toolCalls != null ? toolCalls : 0);

    return user;
  }

  /** Enable or disable a user by setting a flag in Redis. */
  public void updateUserStatus(String userId, boolean enabled) {
    String key = "codepilot:user:disabled:" + userId;
    if (enabled) {
      try {
        redisTemplate.delete(key).block();
      } catch (Exception e) {
        log.warn("Failed to enable user {}", userId, e);
      }
    } else {
      try {
        redisTemplate.opsForValue().set(key, "1").block();
      } catch (Exception e) {
        log.warn("Failed to disable user {}", userId, e);
      }
    }
  }

  /** Get user statistics. */
  public Map<String, Object> getUserStats() {
    String totalSql = "SELECT COUNT(DISTINCT actor) FROM audit_events";
    Long totalUsers = jdbc.queryForObject(totalSql, new MapSqlParameterSource(), Long.class);

    String dauSql =
        """
        SELECT COUNT(DISTINCT actor) FROM audit_events
        WHERE created_at >= CAST(:since AS DATETIME)
        """;
    String today = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.DAYS).toString();
    Long dau = jdbc.queryForObject(dauSql, new MapSqlParameterSource("since", today), Long.class);

    String mauSql =
        """
        SELECT COUNT(DISTINCT actor) FROM audit_events
        WHERE created_at >= CAST(:since AS DATETIME)
        """;
    String monthStart =
        Instant.now()
            .truncatedTo(java.time.temporal.ChronoUnit.DAYS)
            .minus(
                Instant.now().atZone(java.time.ZoneOffset.UTC).getDayOfMonth() - 1,
                java.time.temporal.ChronoUnit.DAYS)
            .toString();
    Long mau =
        jdbc.queryForObject(mauSql, new MapSqlParameterSource("since", monthStart), Long.class);

    Map<String, Object> result = new HashMap<>();
    result.put("totalUsers", totalUsers != null ? totalUsers : 0);
    result.put("dailyActive", dau != null ? dau : 0);
    result.put("monthlyActive", mau != null ? mau : 0);
    return result;
  }

  // ==================== Model Management ====================

  /** List all models (system groups + custom) with usage stats. */
  public Map<String, Object> listModels(int page, int size) {
    List<ModelGroup> groups = modelService.listModelGroups();

    // Query all custom models directly via JDBC (bypass private method)
    String customSql =
        """
        SELECT id, user_id, name, protocol, base_url, model, timeout_ms,
               enabled, created_at, updated_at
        FROM custom_model_providers
        ORDER BY created_at DESC
        """;
    List<Map<String, Object>> customRows =
        jdbc.queryForList(customSql, new MapSqlParameterSource());

    // Combine and paginate
    List<Map<String, Object>> allModels = new java.util.ArrayList<>();

    for (ModelGroup g : groups) {
      Map<String, Object> m = new HashMap<>();
      m.put("id", g.id().toString());
      m.put("name", g.name());
      m.put("provider", g.protocol());
      m.put("model", g.model());
      m.put("enabled", g.enabled());
      m.put("type", "system");
      m.put("maxTokens", g.maxTokens());
      m.put("createdAt", g.createdAt().toString());
      allModels.add(m);
    }

    for (Map<String, Object> c : customRows) {
      Map<String, Object> m = new HashMap<>();
      m.put("id", c.get("id").toString());
      m.put("name", c.get("name"));
      m.put("provider", c.get("protocol"));
      m.put("model", c.get("model"));
      m.put("enabled", c.get("enabled"));
      m.put("type", "custom");
      m.put("userId", c.get("user_id"));
      m.put("maxTokens", 0);
      m.put("createdAt", c.get("created_at").toString());
      allModels.add(m);
    }

    int total = allModels.size();
    int fromIndex = Math.min((page - 1) * size, total);
    int toIndex = Math.min(fromIndex + size, total);
    List<Map<String, Object>> pageItems = allModels.subList(fromIndex, toIndex);

    Map<String, Object> result = new HashMap<>();
    result.put("items", pageItems);
    result.put("total", total);
    result.put("page", page);
    result.put("size", size);
    return result;
  }

  /** Update model configuration (enable/disable, rate limit). */
  public void updateModelConfig(UUID id, Boolean enabled, Integer rateLimitPerMinute) {
    MapSqlParameterSource params = new MapSqlParameterSource().addValue("id", id.toString());
    StringBuilder set = new StringBuilder();

    if (enabled != null) {
      set.append("enabled = :enabled, ");
      params.addValue("enabled", enabled);
    }
    if (rateLimitPerMinute != null) {
      set.append("rate_limit_per_minute = :rateLimit, ");
      params.addValue("rateLimit", rateLimitPerMinute);
    }

    if (set.isEmpty()) {
      throw new CodePilotException(ErrorCodes.BAD_REQUEST, "No fields to update");
    }
    set.setLength(set.length() - 2);

    // Try model_groups first
    String sql = "UPDATE model_groups SET " + set + " WHERE id = :id";
    int rows = jdbc.update(sql, params);

    if (rows == 0) {
      // Try custom_model_providers
      sql = "UPDATE custom_model_providers SET " + set + " WHERE id = :id";
      rows = jdbc.update(sql, params);
    }
    if (rows == 0) {
      throw new CodePilotException(ErrorCodes.NOT_FOUND, "Model not found: " + id);
    }
  }

  /** Get model usage statistics. */
  public Map<String, Object> getModelUsage(UUID id) {
    // Get model name
    ModelGroup group = modelService.findModelGroupById(id);
    String modelName = group != null ? group.name() : id.toString();

    Map<String, Object> result = new HashMap<>();
    result.put("modelId", id.toString());
    result.put("modelName", modelName);

    // Token usage from Prometheus metrics (approximate via audit)
    String usageSql =
        """
        SELECT COUNT(*) AS call_count
        FROM audit_events
        WHERE action = 'tool.execute'
          AND JSON_EXTRACT(payload, '$.toolName') = :modelName
        """;
    Long callCount =
        jdbc.queryForObject(
            usageSql, new MapSqlParameterSource("modelName", modelName), Long.class);
    result.put("callCount", callCount != null ? callCount : 0);

    return result;
  }

  /** Get model statistics (aggregate across all models). */
  public Map<String, Object> getModelStats() {
    List<ModelGroup> groups = modelService.listModelGroups();

    List<Map<String, Object>> modelStats = new java.util.ArrayList<>();
    for (ModelGroup g : groups) {
      Map<String, Object> m = new HashMap<>();
      m.put("id", g.id().toString());
      m.put("name", g.name());
      m.put("provider", g.protocol());
      m.put("enabled", g.enabled());

      String usageSql =
          """
          SELECT COUNT(*) AS call_count
          FROM audit_events
          WHERE action = 'tool.execute'
            AND JSON_EXTRACT(payload, '$.toolName') = :modelName
          """;
      Long callCount =
          jdbc.queryForObject(
              usageSql, new MapSqlParameterSource("modelName", g.name()), Long.class);
      m.put("callCount", callCount != null ? callCount : 0);
      m.put("tokenUsage", 0L);
      modelStats.add(m);
    }

    Map<String, Object> result = new HashMap<>();
    result.put("models", modelStats);
    result.put("totalModels", groups.size());
    return result;
  }

  // ==================== Helpers ====================

  private long parseLong(String value) {
    if (value == null || value.isBlank()) return 0;
    try {
      return Long.parseLong(value);
    } catch (NumberFormatException e) {
      return 0;
    }
  }
}

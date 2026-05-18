package io.codepilot.api.usage;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Usage records and per-user daily quota ceilings.
 *
 * <p>Primary backend: {@code usage_records} / {@code usage_daily_quotas} (Flyway V8). Falls back to
 * JSON file when {@code codepilot.usage.persistence=file} or DB tables are unavailable.
 */
@Component
public class UsagePersistenceStore {

  private static final Logger log = LoggerFactory.getLogger(UsagePersistenceStore.class);
  private static final int DEFAULT_MAX_RECORDS = 10_000;

  private final ObjectMapper mapper = new ObjectMapper();
  private final NamedParameterJdbcTemplate jdbc;
  private final Path storageFile;
  private final String persistenceMode;
  private final int maxRecords;

  private final List<Map<String, Object>> fileRecords = new CopyOnWriteArrayList<>();
  private final Map<String, Double> fileQuotas = new ConcurrentHashMap<>();
  private volatile boolean dbActive;

  public UsagePersistenceStore(
      NamedParameterJdbcTemplate jdbc,
      @Value("${codepilot.usage.persistence:auto}") String persistenceMode,
      @Value("${codepilot.usage.storage-file:${java.io.tmpdir}/codepilot-usage/records.json}") String storageFile,
      @Value("${codepilot.usage.max-records:" + DEFAULT_MAX_RECORDS + "}") int maxRecords) {
    this.jdbc = jdbc;
    this.persistenceMode = persistenceMode != null ? persistenceMode.trim().toLowerCase() : "auto";
    this.storageFile = Path.of(storageFile);
    this.maxRecords = Math.max(100, maxRecords);
  }

  @PostConstruct
  void init() {
    if ("file".equals(persistenceMode)) {
      dbActive = false;
      loadFileSnapshot();
      log.info("Usage persistence: file ({})", storageFile);
      return;
    }
    if (probeDb()) {
      dbActive = true;
      importFileIfDbEmpty();
      log.info("Usage persistence: database");
    } else {
      dbActive = false;
      loadFileSnapshot();
      log.warn("Usage persistence: file fallback ({}) — usage tables missing or DB unreachable", storageFile);
    }
  }

  public boolean isDbBacked() {
    return dbActive;
  }

  public synchronized void addRecord(Map<String, Object> record) {
    if (dbActive) {
      insertDbRecord(record);
      trimDbRecords();
      return;
    }
    fileRecords.add(new LinkedHashMap<>(record));
    while (fileRecords.size() > maxRecords) {
      fileRecords.remove(0);
    }
    persistFile();
  }

  public List<Map<String, Object>> records() {
    if (dbActive) {
      return loadDbRecords();
    }
    return List.copyOf(fileRecords);
  }

  public Map<String, Double> dailyQuotaUsd() {
    if (dbActive) {
      return loadDbQuotas();
    }
    return Map.copyOf(fileQuotas);
  }

  public void setQuota(String userId, double limit) {
    if (dbActive) {
      MapSqlParameterSource params =
          new MapSqlParameterSource("userId", userId).addValue("limit", limit);
      jdbc.update("DELETE FROM usage_daily_quotas WHERE user_id = :userId", params);
      jdbc.update(
          "INSERT INTO usage_daily_quotas (user_id, daily_limit_usd) VALUES (:userId, :limit)",
          params);
      return;
    }
    fileQuotas.put(userId, limit);
    persistFile();
  }

  private boolean probeDb() {
    if ("file".equals(persistenceMode)) return false;
    try {
      jdbc.queryForObject("SELECT COUNT(*) FROM usage_records", Map.of(), Integer.class);
      jdbc.queryForObject("SELECT COUNT(*) FROM usage_daily_quotas", Map.of(), Integer.class);
      return true;
    } catch (DataAccessException e) {
      return false;
    }
  }

  private void importFileIfDbEmpty() {
    try {
      Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM usage_records", Map.of(), Integer.class);
      if (count != null && count > 0) return;
      if (!Files.exists(storageFile)) return;
      UsageSnapshot snap = mapper.readValue(Files.readAllBytes(storageFile), UsageSnapshot.class);
      if (snap.records() != null) {
        for (Map<String, Object> r : snap.records()) {
          insertDbRecord(r);
        }
      }
      if (snap.dailyQuotaUsd() != null) {
        snap.dailyQuotaUsd().forEach(this::setQuota);
      }
      log.info("Imported {} usage records from file into database", snap.records() != null ? snap.records().size() : 0);
    } catch (Exception e) {
      log.warn("Usage file import skipped: {}", e.getMessage());
    }
  }

  private void insertDbRecord(Map<String, Object> record) {
    long ts = longVal(record, "ts", Instant.now().toEpochMilli());
    String userId = stringVal(record, "userId", "default");
    String sessionId = stringVal(record, "sessionId", null);
    String turnId = stringVal(record, "turnId", null);
    String modelId = stringVal(record, "modelId", "default");
    String tier = stringVal(record, "tier", null);
    int inputTokens = intVal(record, "inputTokens");
    int outputTokens = intVal(record, "outputTokens");
    double costUsd = doubleVal(record, "costUsd");
    String source = stringVal(record, "source", null);
    Map<String, Object> extra = new LinkedHashMap<>(record);
    extra.remove("ts");
    extra.remove("userId");
    extra.remove("sessionId");
    extra.remove("turnId");
    extra.remove("modelId");
    extra.remove("tier");
    extra.remove("inputTokens");
    extra.remove("outputTokens");
    extra.remove("costUsd");
    extra.remove("source");
    String extraJson;
    try {
      extraJson = mapper.writeValueAsString(extra);
    } catch (Exception e) {
      extraJson = "{}";
    }
    jdbc.update(
        """
        INSERT INTO usage_records (
            ts_epoch_ms, user_id, session_id, turn_id, model_id, tier,
            input_tokens, output_tokens, cost_usd, source, extra_json)
        VALUES (
            :ts, :userId, :sessionId, :turnId, :modelId, :tier,
            :inputTokens, :outputTokens, :costUsd, :source, :extraJson)
        """,
        new MapSqlParameterSource()
            .addValue("ts", ts)
            .addValue("userId", userId)
            .addValue("sessionId", sessionId)
            .addValue("turnId", turnId)
            .addValue("modelId", modelId)
            .addValue("tier", tier)
            .addValue("inputTokens", inputTokens)
            .addValue("outputTokens", outputTokens)
            .addValue("costUsd", costUsd)
            .addValue("source", source)
            .addValue("extraJson", extraJson));
  }

  private void trimDbRecords() {
    try {
      Long count = jdbc.queryForObject("SELECT COUNT(*) FROM usage_records", Map.of(), Long.class);
      if (count == null || count <= maxRecords) return;
      long toDelete = count - maxRecords;
      jdbc.update(
          "DELETE FROM usage_records ORDER BY ts_epoch_ms ASC LIMIT :n",
          Map.of("n", toDelete));
    } catch (DataAccessException e) {
      log.debug("Usage trim skipped: {}", e.getMessage());
    }
  }

  private List<Map<String, Object>> loadDbRecords() {
    List<Map<String, Object>> rows =
        jdbc.query(
            """
            SELECT ts_epoch_ms, user_id, session_id, turn_id, model_id, tier,
                   input_tokens, output_tokens, cost_usd, source, extra_json
            FROM usage_records
            ORDER BY ts_epoch_ms DESC
            LIMIT :limit
            """,
            Map.of("limit", maxRecords),
            (rs, rowNum) -> {
              Map<String, Object> m = new LinkedHashMap<>();
              m.put("ts", rs.getLong("ts_epoch_ms"));
              m.put("userId", rs.getString("user_id"));
              if (rs.getString("session_id") != null) m.put("sessionId", rs.getString("session_id"));
              if (rs.getString("turn_id") != null) m.put("turnId", rs.getString("turn_id"));
              m.put("modelId", rs.getString("model_id"));
              if (rs.getString("tier") != null) m.put("tier", rs.getString("tier"));
              m.put("inputTokens", rs.getInt("input_tokens"));
              m.put("outputTokens", rs.getInt("output_tokens"));
              m.put("costUsd", rs.getDouble("cost_usd"));
              if (rs.getString("source") != null) m.put("source", rs.getString("source"));
              String extraJson = rs.getString("extra_json");
              if (extraJson != null && !extraJson.isBlank()) {
                try {
                  Map<String, Object> extra =
                      mapper.readValue(extraJson, new TypeReference<>() {});
                  m.putAll(extra);
                } catch (Exception ignored) {
                  // keep core fields only
                }
              }
              return m;
            });
    return new ArrayList<>(rows);
  }

  private Map<String, Double> loadDbQuotas() {
    Map<String, Double> out = new HashMap<>();
    jdbc.query(
        "SELECT user_id, daily_limit_usd FROM usage_daily_quotas",
        Map.of(),
        rs -> {
          out.put(rs.getString("user_id"), rs.getDouble("daily_limit_usd"));
        });
    return out;
  }

  private void loadFileSnapshot() {
    try {
      if (!Files.exists(storageFile)) return;
      UsageSnapshot snap = mapper.readValue(Files.readAllBytes(storageFile), UsageSnapshot.class);
      fileRecords.clear();
      if (snap.records() != null) fileRecords.addAll(snap.records());
      fileQuotas.clear();
      if (snap.dailyQuotaUsd() != null) fileQuotas.putAll(snap.dailyQuotaUsd());
    } catch (Exception e) {
      log.warn("Failed to load usage file: {}", e.getMessage());
    }
  }

  private void persistFile() {
    try {
      Files.createDirectories(storageFile.getParent());
      mapper
          .writerWithDefaultPrettyPrinter()
          .writeValue(
              storageFile.toFile(),
              new UsageSnapshot(new ArrayList<>(fileRecords), new ConcurrentHashMap<>(fileQuotas)));
    } catch (Exception e) {
      log.warn("Failed to persist usage file: {}", e.getMessage());
    }
  }

  private static long longVal(Map<String, Object> r, String key, long defaultVal) {
    Object v = r.get(key);
    return v instanceof Number n ? n.longValue() : defaultVal;
  }

  private static int intVal(Map<String, Object> r, String key) {
    Object v = r.get(key);
    return v instanceof Number n ? n.intValue() : 0;
  }

  private static double doubleVal(Map<String, Object> r, String key) {
    Object v = r.get(key);
    return v instanceof Number n ? n.doubleValue() : 0.0;
  }

  private static String stringVal(Map<String, Object> r, String key, String defaultVal) {
    Object v = r.get(key);
    return v != null ? String.valueOf(v) : defaultVal;
  }

  record UsageSnapshot(List<Map<String, Object>> records, Map<String, Double> dailyQuotaUsd) {}
}

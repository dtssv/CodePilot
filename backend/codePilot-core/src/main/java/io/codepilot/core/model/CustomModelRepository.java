package io.codepilot.core.model;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/**
 * Repository for custom_model table operations.
 *
 * <p>Uses JdbcTemplate wrapped in Mono for reactive compatibility.
 * API key encryption/decryption is handled by {@link ApiKeyEncryptor}.
 */
@Repository
public class CustomModelRepository {

  private static final Logger LOG = LoggerFactory.getLogger(CustomModelRepository.class);
  private static final ObjectMapper MAPPER = new ObjectMapper();

  private static final TypeReference<Map<String, String>> MAP_TYPE = new TypeReference<>() {};
  private static final TypeReference<List<String>> LIST_TYPE = new TypeReference<>() {};

  private static final RowMapper<CustomModelEntity> ROW_MAPPER =
      (rs, rowNum) ->
          new CustomModelEntity(
              rs.getLong("id"),
              rs.getString("user_id"),
              rs.getString("name"),
              rs.getString("protocol"),
              rs.getString("base_url"),
              rs.getString("api_key_enc"),
              rs.getString("model"),
              parseJsonMap(rs.getString("headers")),
              rs.getInt("timeout_ms"),
              parseJsonList(rs.getString("caps")),
              rs.getInt("max_tokens"),
              rs.getTimestamp("created_at").toInstant(),
              rs.getTimestamp("updated_at").toInstant());

  private final JdbcTemplate jdbc;

  public CustomModelRepository(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  public Mono<List<CustomModelEntity>> findByUserId(String userId) {
    return Mono.fromCallable(
            () -> jdbc.query(
                "SELECT * FROM custom_model WHERE user_id = ? ORDER BY created_at",
                ROW_MAPPER, userId))
        .subscribeOn(Schedulers.boundedElastic());
  }

  public Mono<CustomModelEntity> findByIdAndUserId(long id, String userId) {
    return Mono.fromCallable(
            () -> jdbc.queryForObject(
                "SELECT * FROM custom_model WHERE id = ? AND user_id = ?",
                ROW_MAPPER, id, userId))
        .subscribeOn(Schedulers.boundedElastic());
  }

  /** Insert a new custom model. Returns the generated id. */
  public Mono<Long> insert(CustomModelEntity entity) {
    return Mono.fromCallable(() -> {
      var holder = new GeneratedKeyHolder();
      jdbc.update(con -> {
        var ps = con.prepareStatement(
            "INSERT INTO custom_model"
                + " (user_id, name, protocol, base_url, api_key_enc, model,"
                + "  headers, timeout_ms, caps, max_tokens)"
                + " VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::jsonb, ?)",
            new String[] {"id"});
        ps.setString(1, entity.userId());
        ps.setString(2, entity.name());
        ps.setString(3, entity.protocol());
        ps.setString(4, entity.baseUrl());
        ps.setString(5, entity.apiKeyEnc());
        ps.setString(6, entity.model());
        ps.setString(7, toJson(entity.headers()));
        ps.setInt(8, entity.timeoutMs());
        ps.setString(9, toJson(entity.caps()));
        ps.setInt(10, entity.maxTokens());
        return ps;
      }, holder);
      return holder.getKey().longValue();
    }).subscribeOn(Schedulers.boundedElastic());
  }

  public Mono<Void> update(long id, String userId, CustomModelEntity entity) {
    return Mono.<Void>fromCallable(() -> {
      int rows = jdbc.update(
          "UPDATE custom_model SET"
              + " name=?, protocol=?, base_url=?, api_key_enc=?, model=?,"
              + " headers=?::jsonb, timeout_ms=?, caps=?::jsonb, max_tokens=?,"
              + " updated_at=now()"
              + " WHERE id=? AND user_id=?",
          entity.name(), entity.protocol(), entity.baseUrl(), entity.apiKeyEnc(),
          entity.model(), toJson(entity.headers()), entity.timeoutMs(),
          toJson(entity.caps()), entity.maxTokens(), id, userId);
      if (rows == 0) throw new IllegalStateException("Custom model not found or not owned by user");
      return null;
    }).subscribeOn(Schedulers.boundedElastic());
  }

  public Mono<Boolean> deleteByIdAndUserId(long id, String userId) {
    return Mono.fromCallable(
            () -> jdbc.update("DELETE FROM custom_model WHERE id = ? AND user_id = ?", id, userId) > 0)
        .subscribeOn(Schedulers.boundedElastic());
  }

  private static Map<String, String> parseJsonMap(String json) {
    if (json == null || json.isBlank()) return Map.of();
    try { return MAPPER.readValue(json, MAP_TYPE); }
    catch (Exception e) { return Map.of(); }
  }

  private static List<String> parseJsonList(String json) {
    if (json == null || json.isBlank()) return List.of();
    try { return MAPPER.readValue(json, LIST_TYPE); }
    catch (Exception e) { return List.of(); }
  }

  private static String toJson(Object obj) {
    if (obj == null) return "{}";
    try { return MAPPER.writeValueAsString(obj); }
    catch (Exception e) { return "{}"; }
  }
}
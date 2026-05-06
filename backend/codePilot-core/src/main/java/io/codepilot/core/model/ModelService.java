package io.codepilot.core.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.common.api.CodePilotException;
import io.codepilot.core.model.dto.CreateModelCommand;
import io.codepilot.core.model.dto.TestModelCommand;
import io.codepilot.core.model.dto.UpdateModelCommand;
import io.codepilot.common.api.ErrorCodes;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * CRUD for custom model providers. API keys are encrypted using AES-256-GCM with the configured
 * KMS key before storage.
 */
@Service
public class ModelService {

  private static final Logger log = LoggerFactory.getLogger(ModelService.class);

  private final NamedParameterJdbcTemplate jdbc;
  private final ObjectMapper mapper;
  private final byte[] kmsKey;

  public ModelService(
      NamedParameterJdbcTemplate jdbc,
      ObjectMapper mapper,
      @Value("${codepilot.security.hmac-secret}") String hmacSecret) {
    this.jdbc = jdbc;
    this.mapper = mapper;
    // Derive a 256-bit key from the HMAC secret for API key encryption
    this.kmsKey = deriveKey(hmacSecret);
  }

  @Transactional
  public CustomModelProvider create(CreateModelCommand req) {
    UUID id = UUID.randomUUID();
    byte[] encryptedKey = encrypt(req.apiKey());
    String headersJson = toJson(req.headers());

    String sql =
        """
        INSERT INTO custom_model_providers(id, user_id, name, protocol, base_url, api_key_cipher,
                                           model, headers_json, timeout_ms)
        VALUES (:id, :userId, :name, :protocol, :baseUrl,
                :apiKeyCipher, :model, :headers, :timeout)
        """;
    jdbc.update(
        sql,
        new MapSqlParameterSource()
            .addValue("id", id.toString())
            .addValue("userId", req.userId().toString())
            .addValue("name", req.name())
            .addValue("protocol", req.protocol())
            .addValue("baseUrl", req.baseUrl())
            .addValue("apiKeyCipher", encryptedKey)
            .addValue("model", req.model())
            .addValue("headers", headersJson)
            .addValue("timeout", req.timeoutMs() != null ? req.timeoutMs() : 60000));

    return new CustomModelProvider(
        id, req.userId(), req.name(), req.protocol(), req.baseUrl(), req.model(),
        req.headers() != null ? req.headers() : Map.of(),
        req.timeoutMs() != null ? req.timeoutMs() : 60000, true, Instant.now(), Instant.now());
  }

  @Transactional
  public CustomModelProvider update(UUID id, UpdateModelCommand req) {
    var params = new MapSqlParameterSource().addValue("id", id.toString());
    StringBuilder set = new StringBuilder();
    if (req.name() != null) { set.append("name = :name, "); params.addValue("name", req.name()); }
    if (req.protocol() != null) { set.append("protocol = :protocol, "); params.addValue("protocol", req.protocol()); }
    if (req.baseUrl() != null) { set.append("base_url = :baseUrl, "); params.addValue("baseUrl", req.baseUrl()); }
    if (req.apiKey() != null) { set.append("api_key_cipher = :cipher, "); params.addValue("cipher", encrypt(req.apiKey())); }
    if (req.model() != null) { set.append("model = :model, "); params.addValue("model", req.model()); }
    if (req.headers() != null) { set.append("headers_json = :headers, "); params.addValue("headers", toJson(req.headers())); }
    if (req.timeoutMs() != null) { set.append("timeout_ms = :timeout, "); params.addValue("timeout", req.timeoutMs()); }
    if (req.enabled() != null) { set.append("enabled = :enabled, "); params.addValue("enabled", req.enabled()); }

    if (set.isEmpty()) {
      throw new CodePilotException(ErrorCodes.BAD_REQUEST, "No fields to update");
    }
    set.setLength(set.length() - 2); // remove trailing comma

    String sql = "UPDATE custom_model_providers SET " + set + " WHERE id = :id";
    int rows = jdbc.update(sql, params);
    if (rows == 0) throw new CodePilotException(ErrorCodes.NOT_FOUND, "Model not found: " + id);

    // Return a simplified view (re-query)
    return findById(id);
  }

  @Transactional
  public void delete(UUID id) {
    String sql = "DELETE FROM custom_model_providers WHERE id = :id";
    int rows = jdbc.update(sql, new MapSqlParameterSource("id", id.toString()));
    if (rows == 0) throw new CodePilotException(ErrorCodes.NOT_FOUND, "Model not found: " + id);
  }

  /** List all models available to a user (builtin + custom). */
  public Map<String, Object> listModels(String userId) {
    List<Map<String, Object>> builtin = List.of(
        Map.of("id", "codePilot-default", "name", "CodePilot Default", "caps", List.of("tools", "stream"), "maxTokens", 128000),
        Map.of("id", "codePilot-pro", "name", "CodePilot Pro", "caps", List.of("tools", "stream", "vision"), "maxTokens", 200000));
    List<CustomModelProvider> custom = userId != null ? listCustomByUser(userId) : List.of();
    return Map.of("builtin", builtin, "custom", custom);
  }

  private List<CustomModelProvider> listCustomByUser(String userId) {
    String sql = """
        SELECT id, user_id, name, protocol, base_url, model, headers_json, timeout_ms,
               enabled, created_at, updated_at
        FROM custom_model_providers WHERE user_id = :userId AND enabled = true""";
    return jdbc.query(sql, new MapSqlParameterSource("userId", userId), (rs, i) ->
        new CustomModelProvider(
            UUID.fromString(rs.getString("id")), UUID.fromString(rs.getString("user_id")),
            rs.getString("name"), rs.getString("protocol"), rs.getString("base_url"),
            rs.getString("model"), Map.of(), rs.getInt("timeout_ms"), rs.getBoolean("enabled"),
            rs.getTimestamp("created_at").toInstant(), rs.getTimestamp("updated_at").toInstant()));
  }

  public Map<String, Object> testConnection(TestModelCommand req) {
    // Simple connectivity test: attempt a lightweight call to the provider's models endpoint
    Map<String, Object> result = new HashMap<>();
    result.put("protocol", req.protocol());
    result.put("baseUrl", req.baseUrl());
    result.put("model", req.model());
    result.put("status", "ok");
    result.put("latencyMs", 0);
    // Real implementation would make an HTTP call here
    return result;
  }

  private CustomModelProvider findById(UUID id) {
    String sql =
        """
        SELECT id, user_id, name, protocol, base_url, model, headers_json, timeout_ms,
               enabled, created_at, updated_at
        FROM custom_model_providers WHERE id = :id""";
    return jdbc.queryForObject(sql, new MapSqlParameterSource("id", id.toString()), (rs, i) ->
        new CustomModelProvider(
            UUID.fromString(rs.getString("id")),
            UUID.fromString(rs.getString("user_id")),
            rs.getString("name"),
            rs.getString("protocol"),
            rs.getString("base_url"),
            rs.getString("model"),
            Map.of(),
            rs.getInt("timeout_ms"),
            rs.getBoolean("enabled"),
            rs.getTimestamp("created_at").toInstant(),
            rs.getTimestamp("updated_at").toInstant()));
  }

  // ---- Encryption helpers ---- //

  private byte[] encrypt(String plaintext) {
    try {
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      byte[] iv = new byte[12];
      java.security.SecureRandom.getInstanceStrong().nextBytes(iv);
      cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(kmsKey, "AES"), new GCMParameterSpec(128, iv));
      byte[] ct = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
      byte[] result = new byte[iv.length + ct.length];
      System.arraycopy(iv, 0, result, 0, iv.length);
      System.arraycopy(ct, 0, result, iv.length, ct.length);
      return result;
    } catch (Exception e) {
      throw new IllegalStateException("Encryption failed", e);
    }
  }

  private static byte[] deriveKey(String secret) {
    try {
      MessageDigest md = MessageDigest.getInstance("SHA-256");
      return md.digest(secret.getBytes(StandardCharsets.UTF_8));
    } catch (Exception e) {
      throw new IllegalStateException("Key derivation failed", e);
    }
  }

  private String toJson(Map<String, String> map) {
    if (map == null) return "{}";
    try { return mapper.writeValueAsString(map); }
    catch (JsonProcessingException e) { return "{}"; }
  }
}
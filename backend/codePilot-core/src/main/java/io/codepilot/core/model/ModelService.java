package io.codepilot.core.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.common.api.CodePilotException;
import io.codepilot.common.api.ErrorCodes;
import io.codepilot.core.model.dto.CreateModelCommand;
import io.codepilot.core.model.dto.TestModelCommand;
import io.codepilot.core.model.dto.UpdateModelCommand;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
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
 * CRUD for model providers. Supports two categories:
 * <ul>
 *   <li><b>System models</b> — configured by administrators in {@code system_model_providers},
 *       available to all users. These have their own base_url, model name, and api_key.</li>
 *   <li><b>Custom models</b> — per-user models in {@code custom_model_providers},
 *       only the owning user can view/update/delete.</li>
 * </ul>
 * API keys are encrypted using AES-256-GCM with the configured KMS key before storage.
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
            .addValue("userId", req.userId())
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
  public CustomModelProvider update(UUID id, String userId, UpdateModelCommand req) {
    // Verify ownership: only the owning user can update their custom model
    verifyOwnership(id, userId);

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

    return findById(id);
  }

  @Transactional
  public void delete(UUID id, String userId) {
    // Verify ownership: only the owning user can delete their custom model
    verifyOwnership(id, userId);

    String sql = "DELETE FROM custom_model_providers WHERE id = :id AND user_id = :userId";
    int rows = jdbc.update(sql, new MapSqlParameterSource()
        .addValue("id", id.toString())
        .addValue("userId", userId));
    if (rows == 0) throw new CodePilotException(ErrorCodes.NOT_FOUND, "Model not found: " + id);
  }

  /**
   * List all models available to a user: model groups (replacing system models) + user's custom models.
   * Model groups are the new user-facing concept; each group contains multiple app keys
   * for load balancing, but users only see the group-level info.
   */
  public Map<String, Object> listModels(String userId) {
    List<ModelGroup> groups = listModelGroups();
    List<CustomModelProvider> custom = userId != null ? listCustomByUser(userId) : List.of();
    // Return groups as "system" for backward compatibility, but enrich every
    // row with Cursor-style routing metadata so clients do not need to guess.
    return Map.of(
        "system", groups.stream().map(this::modelGroupDto).toList(),
        "custom", custom.stream().map(this::customModelDto).toList());
  }

  private Map<String, Object> modelGroupDto(ModelGroup g) {
    String id = g.id().toString();
    String model = g.model();
    List<String> capabilities = normalizeCapabilities(model, g.capabilities());
    return Map.ofEntries(
        Map.entry("id", id),
        Map.entry("name", g.name()),
        Map.entry("model", model),
        Map.entry("type", "system"),
        Map.entry("source", "group"),
        Map.entry("protocol", g.protocol()),
        Map.entry("tier", inferTier(model, capabilities, g.maxTokens())),
        Map.entry("capabilities", capabilities),
        Map.entry("contextWindow", inferContextWindow(g.maxTokens(), capabilities)),
        Map.entry("pricing", inferPricing(model)),
        Map.entry("maxTokens", g.maxTokens()),
        Map.entry("timeoutMs", g.timeoutMs()));
  }

  private Map<String, Object> customModelDto(CustomModelProvider p) {
    String id = p.id().toString();
    String model = p.model();
    List<String> capabilities = normalizeCapabilities(model, List.of("TEXT", "TOOL_USE"));
    return Map.ofEntries(
        Map.entry("id", id),
        Map.entry("name", p.name()),
        Map.entry("model", model),
        Map.entry("type", "custom"),
        Map.entry("source", "custom"),
        Map.entry("protocol", p.protocol()),
        Map.entry("tier", inferTier(model, capabilities, 0)),
        Map.entry("capabilities", capabilities),
        Map.entry("contextWindow", inferContextWindow(0, capabilities)),
        Map.entry("pricing", inferPricing(model)),
        Map.entry("timeoutMs", p.timeoutMs()));
  }

  private List<String> normalizeCapabilities(String model, List<String> raw) {
    java.util.LinkedHashSet<String> caps = new java.util.LinkedHashSet<>();
    if (raw != null) {
      raw.stream()
          .filter(c -> c != null && !c.isBlank())
          .map(c -> c.trim().toUpperCase(java.util.Locale.ROOT).replace('-', '_'))
          .forEach(caps::add);
    }
    String id = model == null ? "" : model.toLowerCase(java.util.Locale.ROOT);
    caps.add("TEXT");
    caps.add("TOOL_USE");
    if (id.contains("vision") || id.contains("gpt-4") || id.contains("gpt-5")
        || id.contains("claude") || id.contains("gemini")) caps.add("VISION");
    if (id.contains("gpt") || id.contains("claude") || id.contains("gemini")) caps.add("JSON_MODE");
    if (id.contains("200k") || id.contains("256k") || id.contains("claude")) caps.add("LONG_CTX_256K");
    if (id.contains("1m") || id.contains("gemini")) caps.add("LONG_CTX_1M");
    return List.copyOf(caps);
  }

  private String inferTier(String model, List<String> capabilities, int maxTokens) {
    String id = model == null ? "" : model.toLowerCase(java.util.Locale.ROOT);
    if (id.contains("haiku") || id.contains("flash") || id.contains("mini") || id.contains("fast")) return "FAST";
    if (id.contains("opus") || id.contains("max") || id.contains("gpt-5")) return "PREMIUM";
    if (id.contains("thinking") || id.contains("reason") || id.contains("sonnet")) return "THINKING";
    if (capabilities.contains("LONG_CTX_1M") || maxTokens >= 256_000) return "PREMIUM";
    return "DEFAULT";
  }

  private int inferContextWindow(int maxTokens, List<String> capabilities) {
    if (maxTokens > 0) return maxTokens;
    if (capabilities.contains("LONG_CTX_1M")) return 1_000_000;
    if (capabilities.contains("LONG_CTX_256K")) return 256_000;
    return 128_000;
  }

  private Map<String, Double> inferPricing(String model) {
    String tier = inferTier(model, normalizeCapabilities(model, List.of()), 0);
    return switch (tier) {
      case "FAST" -> Map.of("inputPerM", 0.25, "outputPerM", 1.25);
      case "THINKING" -> Map.of("inputPerM", 3.0, "outputPerM", 15.0);
      case "PREMIUM" -> Map.of("inputPerM", 15.0, "outputPerM", 75.0);
      default -> Map.of("inputPerM", 1.5, "outputPerM", 5.0);
    };
  }

  // ---- Model Group CRUD ---- //

  /**
   * List all enabled model groups, ordered by sort_order.
   */
  public List<ModelGroup> listModelGroups() {
    String sql = """
        SELECT id, name, protocol, base_url, model, capabilities, max_tokens,
               timeout_ms, enabled, sort_order, created_at, updated_at
        FROM model_groups
        WHERE enabled = 1
        ORDER BY sort_order ASC""";
    return jdbc.query(sql, new MapSqlParameterSource(), (rs, i) -> {
      String capsJson = rs.getString("capabilities");
      List<String> caps = parseCapabilities(capsJson);
      return new ModelGroup(
          UUID.fromString(rs.getString("id")),
          rs.getString("name"),
          rs.getString("protocol"),
          rs.getString("model"),
          rs.getString("base_url"),
          caps,
          rs.getInt("max_tokens"),
          rs.getInt("timeout_ms"),
          rs.getBoolean("enabled"),
          rs.getInt("sort_order"),
          rs.getTimestamp("created_at").toInstant(),
          rs.getTimestamp("updated_at").toInstant());
    });
  }

  /**
   * Find a model group by ID.
   */
  public ModelGroup findModelGroupById(UUID id) {
    String sql = """
        SELECT id, name, protocol, base_url, model, capabilities, max_tokens,
               timeout_ms, enabled, sort_order, created_at, updated_at
        FROM model_groups WHERE id = :id AND enabled = 1""";
    var rows = jdbc.query(sql, new MapSqlParameterSource("id", id.toString()), (rs, i) -> {
      String capsJson = rs.getString("capabilities");
      List<String> caps = parseCapabilities(capsJson);
      return new ModelGroup(
          UUID.fromString(rs.getString("id")),
          rs.getString("name"),
          rs.getString("protocol"),
          rs.getString("model"),
          rs.getString("base_url"),
          caps,
          rs.getInt("max_tokens"),
          rs.getInt("timeout_ms"),
          rs.getBoolean("enabled"),
          rs.getInt("sort_order"),
          rs.getTimestamp("created_at").toInstant(),
          rs.getTimestamp("updated_at").toInstant());
    });
    return rows.isEmpty() ? null : rows.getFirst();
  }

  /**
   * Create a new model group.
   */
  @Transactional
  public ModelGroup createModelGroup(String name, String protocol, String baseUrl,
      String model, List<String> capabilities, int maxTokens, int timeoutMs, int sortOrder) {
    UUID id = UUID.randomUUID();
    String capsJson = toJson(capabilities);
    String sql = """
        INSERT INTO model_groups(id, name, protocol, base_url, model, capabilities,
                                max_tokens, headers_json, timeout_ms, enabled, sort_order)
        VALUES (:id, :name, :protocol, :baseUrl, :model, :capabilities,
                :maxTokens, :headers, :timeoutMs, 1, :sortOrder)""";
    jdbc.update(sql, new MapSqlParameterSource()
        .addValue("id", id.toString())
        .addValue("name", name)
        .addValue("protocol", protocol)
        .addValue("baseUrl", baseUrl)
        .addValue("model", model)
        .addValue("capabilities", capsJson)
        .addValue("maxTokens", maxTokens)
        .addValue("headers", "{}")
        .addValue("timeoutMs", timeoutMs)
        .addValue("sortOrder", sortOrder));
    return findModelGroupById(id);
  }

  /**
   * Update a model group.
   */
  @Transactional
  public ModelGroup updateModelGroup(UUID id, String name, String protocol, String baseUrl,
      String model, List<String> capabilities, Integer maxTokens, Integer timeoutMs,
      Boolean enabled, Integer sortOrder) {
    var params = new MapSqlParameterSource().addValue("id", id.toString());
    StringBuilder set = new StringBuilder();
    if (name != null) { set.append("name = :name, "); params.addValue("name", name); }
    if (protocol != null) { set.append("protocol = :protocol, "); params.addValue("protocol", protocol); }
    if (baseUrl != null) { set.append("base_url = :baseUrl, "); params.addValue("baseUrl", baseUrl); }
    if (model != null) { set.append("model = :model, "); params.addValue("model", model); }
    if (capabilities != null) { set.append("capabilities = :caps, "); params.addValue("caps", toJson(capabilities)); }
    if (maxTokens != null) { set.append("max_tokens = :maxTokens, "); params.addValue("maxTokens", maxTokens); }
    if (timeoutMs != null) { set.append("timeout_ms = :timeoutMs, "); params.addValue("timeoutMs", timeoutMs); }
    if (enabled != null) { set.append("enabled = :enabled, "); params.addValue("enabled", enabled); }
    if (sortOrder != null) { set.append("sort_order = :sortOrder, "); params.addValue("sortOrder", sortOrder); }

    if (set.isEmpty()) {
      throw new CodePilotException(ErrorCodes.BAD_REQUEST, "No fields to update");
    }
    set.setLength(set.length() - 2);

    String sql = "UPDATE model_groups SET " + set + " WHERE id = :id";
    int rows = jdbc.update(sql, params);
    if (rows == 0) throw new CodePilotException(ErrorCodes.NOT_FOUND, "Model group not found: " + id);
    return findModelGroupById(id);
  }

  /**
   * Delete a model group (cascades to app keys).
   */
  @Transactional
  public void deleteModelGroup(UUID id) {
    String sql = "DELETE FROM model_groups WHERE id = :id";
    int rows = jdbc.update(sql, new MapSqlParameterSource("id", id.toString()));
    if (rows == 0) throw new CodePilotException(ErrorCodes.NOT_FOUND, "Model group not found: " + id);
  }

  // ---- Model App Key CRUD ---- //

  /**
   * List all app keys for a model group.
   */
  public List<ModelAppKey> listAppKeysByGroup(UUID groupId) {
    String sql = """
        SELECT id, group_id, name, base_url, weight,
               max_concurrency, rpm_limit, tpm_limit, priority,
               enabled, created_at, updated_at
        FROM model_app_keys
        WHERE group_id = :groupId
        ORDER BY created_at ASC""";
    return jdbc.query(sql, new MapSqlParameterSource("groupId", groupId.toString()), (rs, i) ->
        new ModelAppKey(
            UUID.fromString(rs.getString("id")),
            UUID.fromString(rs.getString("group_id")),
            rs.getString("name"),
            rs.getString("base_url"),
            rs.getInt("weight"),
            rs.getInt("max_concurrency"),
            rs.getInt("rpm_limit"),
            rs.getInt("tpm_limit"),
            rs.getInt("priority"),
            rs.getBoolean("enabled"),
            rs.getTimestamp("created_at").toInstant(),
            rs.getTimestamp("updated_at").toInstant()));
  }

  /**
   * Create a new app key under a model group.
   */
  @Transactional
  public ModelAppKey createAppKey(UUID groupId, String name, String baseUrl,
      String apiKey, int weight, int maxConcurrency, int rpmLimit, int tpmLimit, int priority) {
    UUID id = UUID.randomUUID();
    byte[] encryptedKey = encrypt(apiKey);
    String sql = """
        INSERT INTO model_app_keys(id, group_id, name, base_url, api_key_cipher, weight,
                                   max_concurrency, rpm_limit, tpm_limit, priority, enabled)
        VALUES (:id, :groupId, :name, :baseUrl, :apiKeyCipher, :weight,
                :maxConcurrency, :rpmLimit, :tpmLimit, :priority, 1)""";
    jdbc.update(sql, new MapSqlParameterSource()
        .addValue("id", id.toString())
        .addValue("groupId", groupId.toString())
        .addValue("name", name)
        .addValue("baseUrl", baseUrl)
        .addValue("apiKeyCipher", encryptedKey)
        .addValue("weight", weight)
        .addValue("maxConcurrency", maxConcurrency)
        .addValue("rpmLimit", rpmLimit)
        .addValue("tpmLimit", tpmLimit)
        .addValue("priority", priority));
    return new ModelAppKey(id, groupId, name, baseUrl, weight,
        maxConcurrency, rpmLimit, tpmLimit, priority, true, Instant.now(), Instant.now());
  }

  /**
   * Update an app key.
   */
  @Transactional
  public ModelAppKey updateAppKey(UUID id, String name, String baseUrl,
      String apiKey, Integer weight, Integer maxConcurrency, Integer rpmLimit,
      Integer tpmLimit, Integer priority, Boolean enabled) {
    var params = new MapSqlParameterSource().addValue("id", id.toString());
    StringBuilder set = new StringBuilder();
    if (name != null) { set.append("name = :name, "); params.addValue("name", name); }
    if (baseUrl != null) { set.append("base_url = :baseUrl, "); params.addValue("baseUrl", baseUrl); }
    if (apiKey != null) { set.append("api_key_cipher = :cipher, "); params.addValue("cipher", encrypt(apiKey)); }
    if (weight != null) { set.append("weight = :weight, "); params.addValue("weight", weight); }
    if (maxConcurrency != null) { set.append("max_concurrency = :maxConcurrency, "); params.addValue("maxConcurrency", maxConcurrency); }
    if (rpmLimit != null) { set.append("rpm_limit = :rpmLimit, "); params.addValue("rpmLimit", rpmLimit); }
    if (tpmLimit != null) { set.append("tpm_limit = :tpmLimit, "); params.addValue("tpmLimit", tpmLimit); }
    if (priority != null) { set.append("priority = :priority, "); params.addValue("priority", priority); }
    if (enabled != null) { set.append("enabled = :enabled, "); params.addValue("enabled", enabled); }

    if (set.isEmpty()) {
      throw new CodePilotException(ErrorCodes.BAD_REQUEST, "No fields to update");
    }
    set.setLength(set.length() - 2);

    String sql = "UPDATE model_app_keys SET " + set + " WHERE id = :id";
    int rows = jdbc.update(sql, params);
    if (rows == 0) throw new CodePilotException(ErrorCodes.NOT_FOUND, "App key not found: " + id);

    return findAppKeyById(id);
  }

  /**
   * Delete an app key.
   */
  @Transactional
  public void deleteAppKey(UUID id) {
    String sql = "DELETE FROM model_app_keys WHERE id = :id";
    int rows = jdbc.update(sql, new MapSqlParameterSource("id", id.toString()));
    if (rows == 0) throw new CodePilotException(ErrorCodes.NOT_FOUND, "App key not found: " + id);
  }

  /**
   * Find an app key by ID.
   */
  public ModelAppKey findAppKeyById(UUID id) {
    String sql = """
        SELECT id, group_id, name, base_url, weight,
               max_concurrency, rpm_limit, tpm_limit, priority,
               enabled, created_at, updated_at
        FROM model_app_keys WHERE id = :id""";
    var rows = jdbc.query(sql, new MapSqlParameterSource("id", id.toString()), (rs, i) ->
        new ModelAppKey(
            UUID.fromString(rs.getString("id")),
            UUID.fromString(rs.getString("group_id")),
            rs.getString("name"),
            rs.getString("base_url"),
            rs.getInt("weight"),
            rs.getInt("max_concurrency"),
            rs.getInt("rpm_limit"),
            rs.getInt("tpm_limit"),
            rs.getInt("priority"),
            rs.getBoolean("enabled"),
            rs.getTimestamp("created_at").toInstant(),
            rs.getTimestamp("updated_at").toInstant()));
    return rows.isEmpty() ? null : rows.getFirst();
  }

  /**
   * Get the decrypted API key cipher for an app key.
   */
  public String getDecryptedApiKey(UUID appKeyId) {
    String sql = "SELECT api_key_cipher FROM model_app_keys WHERE id = :id";
    var rows = jdbc.queryForList(sql, new MapSqlParameterSource("id", appKeyId.toString()));
    if (rows.isEmpty()) return null;
    byte[] cipher = (byte[]) rows.getFirst().get("api_key_cipher");
    // Use ChatClientFactory's decrypt — we expose a decrypt method here for internal use
    return decrypt(cipher);
  }

  /**
   * Get the base URL override for an app key, falling back to the group's base URL.
   */
  public String resolveAppKeyBaseUrl(UUID appKeyId) {
    String sql = "SELECT base_url, group_id FROM model_app_keys WHERE id = :id";
    var rows = jdbc.queryForList(sql, new MapSqlParameterSource("id", appKeyId.toString()));
    if (rows.isEmpty()) return null;
    String baseUrl = (String) rows.getFirst().get("base_url");
    if (baseUrl != null && !baseUrl.isBlank()) return baseUrl;
    // Fall back to group's base_url
    UUID groupId = UUID.fromString((String) rows.getFirst().get("group_id"));
    ModelGroup group = findModelGroupById(groupId);
    return group != null ? group.baseUrl() : null;
  }

  // ---- Custom model methods ---- //

  private List<CustomModelProvider> listCustomByUser(String userId) {
    String sql = """
        SELECT id, user_id, name, protocol, base_url, model, headers_json, timeout_ms,
               enabled, created_at, updated_at
        FROM custom_model_providers WHERE user_id = :userId AND enabled = 1""";
    return jdbc.query(sql, new MapSqlParameterSource("userId", userId), (rs, i) ->
        new CustomModelProvider(
            UUID.fromString(rs.getString("id")), rs.getString("user_id"),
            rs.getString("name"), rs.getString("protocol"), rs.getString("base_url"),
            rs.getString("model"), Map.of(), rs.getInt("timeout_ms"), rs.getBoolean("enabled"),
            rs.getTimestamp("created_at").toInstant(), rs.getTimestamp("updated_at").toInstant()));
  }

  public Map<String, Object> testConnection(TestModelCommand req) {
    Map<String, Object> result = new HashMap<>();
    result.put("protocol", req.protocol());
    result.put("baseUrl", req.baseUrl());
    result.put("model", req.model());
    result.put("status", "ok");
    result.put("latencyMs", 0);
    // Real implementation would make an HTTP call here
    return result;
  }

  // ---- Ownership verification ---- //

  private void verifyOwnership(UUID modelId, String userId) {
    String sql = "SELECT user_id FROM custom_model_providers WHERE id = :id";
    var rows = jdbc.queryForList(sql, new MapSqlParameterSource("id", modelId.toString()));
    if (rows.isEmpty()) {
      throw new CodePilotException(ErrorCodes.NOT_FOUND, "Model not found: " + modelId);
    }
    String ownerId = (String) rows.getFirst().get("user_id");
    if (!ownerId.equals(userId)) {
      throw new CodePilotException(ErrorCodes.FORBIDDEN, "Cannot modify model owned by another user");
    }
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
            rs.getString("user_id"),
            rs.getString("name"), rs.getString("protocol"), rs.getString("base_url"),
            rs.getString("model"), Map.of(), rs.getInt("timeout_ms"), rs.getBoolean("enabled"),
            rs.getTimestamp("created_at").toInstant(), rs.getTimestamp("updated_at").toInstant()));
  }

  // ---- Helpers ---- //

  private List<String> parseCapabilities(String json) {
    if (json == null || json.isBlank()) return List.of();
    try {
      return mapper.readValue(json, new TypeReference<>() {});
    } catch (JsonProcessingException e) {
      return List.of();
    }
  }

  // ---- Encryption helpers ---- //

  byte[] encrypt(String plaintext) {
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

  private String toJson(List<String> list) {
    if (list == null) return "[]";
    try { return mapper.writeValueAsString(list); }
    catch (JsonProcessingException e) { return "[]"; }
  }

  // ---- Decryption (exposed for internal use by ChatClientFactory) ---- //

  String decrypt(byte[] ciphertext) {
    try {
      byte[] iv = new byte[12];
      System.arraycopy(ciphertext, 0, iv, 0, 12);
      byte[] ct = new byte[ciphertext.length - 12];
      System.arraycopy(ciphertext, 12, ct, 0, ct.length);
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(kmsKey, "AES"), new GCMParameterSpec(128, iv));
      return new String(c.doFinal(ct), StandardCharsets.UTF_8);
    } catch (Exception e) {
      throw new IllegalStateException("Decryption failed", e);
    }
  }
}
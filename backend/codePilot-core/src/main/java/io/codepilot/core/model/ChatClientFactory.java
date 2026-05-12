package io.codepilot.core.model;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.ai.openai.api.OpenAiApi;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Resolves a {@link ChatClient} based on the model ID in the request. Supports:
 * <ul>
 *   <li><b>Model groups</b> — stored in {@code model_groups}, each with multiple app keys in
 *       {@code model_app_keys}. The load balancer selects the least-loaded app key.</li>
 *   <li><b>Custom models</b> — per-user models in {@code custom_model_providers}.</li>
 * </ul>
 *
 * <p>Resolution order: model group → custom model → fallback to first enabled model group.
 * <p>ChatClients are cached in Caffeine to avoid repeated construction on each request.
 * <p>For model groups, the cache key is the selected appKey ID (not the group ID),
 * so different app keys within the same group are treated as separate ChatClients.
 *
 * <p>Callers should use {@link #resolve(String)} to get a {@link ResolvedClient},
 * then call {@link ResolvedClient#startRequest()} before and {@link ResolvedClient#endRequest(boolean, int)}
 * after the actual LLM call to properly track concurrency, rate limits, and circuit-breaker state.
 */
@Component
public class ChatClientFactory {

  private static final Logger log = LoggerFactory.getLogger(ChatClientFactory.class);

  private final NamedParameterJdbcTemplate jdbc;
  private final byte[] kmsKey;
  private final AppKeyLoadBalancer loadBalancer;

  /** Cache: providerId/appKeyId → ChatClient (evicts after 1 hour idle). */
  private final Cache<UUID, ChatClient> clientCache =
      Caffeine.newBuilder().expireAfterAccess(Duration.ofHours(1)).maximumSize(128).build();

  public ChatClientFactory(
      NamedParameterJdbcTemplate jdbc,
      AppKeyLoadBalancer loadBalancer,
      @Value("${codepilot.security.hmac-secret}") String hmacSecret) {
    this.jdbc = jdbc;
    this.loadBalancer = loadBalancer;
    this.kmsKey = deriveKey(hmacSecret);
  }

  // ========================================================================
  // ResolvedClient — wraps ChatClient + load-tracking metadata
  // ========================================================================

  /**
   * Result of resolving a model ID. Carries the {@link ChatClient} along with
   * the resolved appKeyId (if from a model group) so that callers can properly
   * track request lifecycle via {@link #startRequest()} / {@link #endRequest(boolean, int)}.
   */
  public static class ResolvedClient {
    private final ChatClient chatClient;
    private final UUID appKeyId; // null for custom models
    private final AppKeyLoadBalancer loadBalancer;

    ResolvedClient(ChatClient chatClient, UUID appKeyId, AppKeyLoadBalancer loadBalancer) {
      this.chatClient = chatClient;
      this.appKeyId = appKeyId;
      this.loadBalancer = loadBalancer;
    }

    /** The resolved ChatClient ready for use. */
    public ChatClient chatClient() { return chatClient; }

    /** Whether this client was resolved from a model group with load balancing. */
    public boolean isModelGroup() { return appKeyId != null; }

    /** The appKeyId if from a model group, null otherwise. */
    public UUID appKeyId() { return appKeyId; }

    /**
     * Call before the actual LLM request to increment concurrency and RPM counters.
     * For model-group clients, this increments the load balancer counters.
     * No-op for custom models.
     */
    public void startRequest() {
      if (appKeyId != null) {
        loadBalancer.acquire(appKeyId);
      }
    }

    /**
     * Call after the LLM request completes to decrement concurrency and report outcome.
     * For model-group clients:
     * <ul>
     *   <li>Decrements concurrency counter</li>
     *   <li>On success: records token usage for TPM tracking; resets circuit-breaker failures</li>
     *   <li>On failure: increments circuit-breaker failure counter (may open the breaker)</li>
     * </ul>
     *
     * @param success    whether the LLM call succeeded
     * @param tokensUsed token count from the response (0 if unknown or failed)
     */
    public void endRequest(boolean success, int tokensUsed) {
      if (appKeyId != null) {
        loadBalancer.release(appKeyId);
        if (success) {
          loadBalancer.recordSuccess(appKeyId, tokensUsed);
        } else {
          loadBalancer.recordFailure(appKeyId);
        }
      }
    }
  }

  // ========================================================================
  // Resolve methods
  // ========================================================================

  /**
   * Resolves a model ID to a {@link ResolvedClient}.
   *
   * <p>Resolution order:
   * 1. Model group (from model_groups + model_app_keys with load balancing)
   * 2. Custom model (from custom_model_providers)
   * 3. Fallback: first enabled model group by sort_order
   */
  public ResolvedClient resolve(String modelId) {
    if (modelId == null || modelId.isBlank()) {
      return buildDefaultResolved();
    }

    UUID id;
    try {
      id = UUID.fromString(modelId);
    } catch (IllegalArgumentException e) {
      return buildDefaultResolved();
    }

    // 1. Try model group
    ResolvedClient groupClient = tryResolveModelGroup(id);
    if (groupClient != null) return groupClient;

    // 2. Try custom model
    ChatClient customClient = tryBuildCustomClient(id);
    if (customClient != null) return new ResolvedClient(customClient, null, loadBalancer);

    // 3. Fallback to default
    log.warn("Model provider not found: {}, falling back to default model", id);
    return buildDefaultResolved();
  }

  /**
   * Backward-compatible convenience method: returns just the ChatClient.
   * Prefer {@link #resolve(String)} for proper load tracking.
   */
  public ChatClient resolveClient(String modelId) {
    return resolve(modelId).chatClient();
  }

  // ========================================================================
  // Model group resolution
  // ========================================================================

  private ResolvedClient tryResolveModelGroup(UUID groupId) {
    String groupSql = "SELECT id, model FROM model_groups WHERE id = :id AND enabled = 1";
    var groupRows = jdbc.queryForList(groupSql, new MapSqlParameterSource("id", groupId.toString()));
    if (groupRows.isEmpty()) return null;

    String modelName = (String) groupRows.getFirst().get("model");

    // Select the best app key via load balancer
    UUID appKeyId = loadBalancer.selectAppKey(groupId);
    if (appKeyId == null) {
      log.warn("No available app key for model group: {}", groupId);
      return null;
    }

    // Build or get cached ChatClient for this specific app key
    ChatClient client = clientCache.get(appKeyId, key -> buildClientFromAppKey(key, modelName, groupId));
    if (client == null) return null;

    return new ResolvedClient(client, appKeyId, loadBalancer);
  }

  private ChatClient buildClientFromAppKey(UUID appKeyId, String modelName, UUID groupId) {
    String sql = "SELECT base_url, api_key_cipher FROM model_app_keys WHERE id = :id AND enabled = 1";
    var rows = jdbc.queryForList(sql, new MapSqlParameterSource("id", appKeyId.toString()));
    if (rows.isEmpty()) return null;

    var row = rows.getFirst();
    String appKeyBaseUrl = (String) row.get("base_url");
    byte[] cipher = (byte[]) row.get("api_key_cipher");

    // If app key has its own base_url, use it; otherwise fall back to group's base_url
    String baseUrl = appKeyBaseUrl;
    if (baseUrl == null || baseUrl.isBlank()) {
      String groupUrlSql = "SELECT base_url FROM model_groups WHERE id = :groupId";
      var groupRows = jdbc.queryForList(groupUrlSql, new MapSqlParameterSource("groupId", groupId.toString()));
      if (!groupRows.isEmpty()) {
        baseUrl = (String) groupRows.getFirst().get("base_url");
      }
    }

    String apiKey = decrypt(cipher);
    OpenAiApi api = OpenAiApi.builder().baseUrl(baseUrl).apiKey(apiKey).build();
    OpenAiChatOptions opts = OpenAiChatOptions.builder().model(modelName).build();
    OpenAiChatModel chatModel = OpenAiChatModel.builder().openAiApi(api).defaultOptions(opts).build();

    log.info("Built ChatClient [model-group] for groupId={} appKeyId={} model={}", groupId, appKeyId, modelName);
    return ChatClient.builder(chatModel).build();
  }

  // ========================================================================
  // Custom model resolution
  // ========================================================================

  private ChatClient tryBuildCustomClient(UUID providerId) {
    String sql = "SELECT base_url, api_key_cipher, model, timeout_ms FROM custom_model_providers WHERE id = :id AND enabled = 1";
    var rows = jdbc.queryForList(sql, new MapSqlParameterSource("id", providerId.toString()));
    if (rows.isEmpty()) return null;

    var row = rows.getFirst();
    return buildClientFromRow(row, "custom", providerId);
  }

  private ResolvedClient buildDefaultResolved() {
    // Default: first enabled model group
    String sql = "SELECT id FROM model_groups WHERE enabled = 1 ORDER BY sort_order ASC LIMIT 1";
    var rows = jdbc.queryForList(sql, new MapSqlParameterSource());
    if (!rows.isEmpty()) {
      UUID groupId = UUID.fromString((String) rows.getFirst().get("id"));
      ResolvedClient client = tryResolveModelGroup(groupId);
      if (client != null) return client;
    }

    throw new IllegalStateException("No enabled model group configured. Please add at least one model group.");
  }

  private ChatClient buildClientFromRow(java.util.Map<String, Object> row, String source, UUID providerId) {
    String baseUrl = (String) row.get("base_url");
    byte[] cipher = (byte[]) row.get("api_key_cipher");
    String model = (String) row.get("model");

    String apiKey = decrypt(cipher);
    OpenAiApi api = OpenAiApi.builder().baseUrl(baseUrl).apiKey(apiKey).build();
    OpenAiChatOptions opts = OpenAiChatOptions.builder().model(model).build();
    OpenAiChatModel chatModel = OpenAiChatModel.builder().openAiApi(api).defaultOptions(opts).build();

    log.info("Built ChatClient [{}] for provider={} model={}", source, providerId, model);
    return ChatClient.builder(chatModel).build();
  }

  // ========================================================================
  // Crypto helpers
  // ========================================================================

  private String decrypt(byte[] ciphertext) {
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

  private static byte[] deriveKey(String secret) {
    try {
      return java.security.MessageDigest.getInstance("SHA-256").digest(secret.getBytes(StandardCharsets.UTF_8));
    } catch (Exception e) { throw new IllegalStateException(e); }
  }
}
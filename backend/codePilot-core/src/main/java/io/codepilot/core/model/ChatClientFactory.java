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
 * Resolves a {@link ChatClient} and {@link OpenAiChatModel} based on the model ID in the request.
 *
 * <p>The {@link OpenAiChatModel} is exposed via {@link ResolvedClient#chatModel()} so callers can
 * use it directly for streaming and tool call handling.
 */
@Component
public class ChatClientFactory {

  private static final Logger log = LoggerFactory.getLogger(ChatClientFactory.class);

  private final NamedParameterJdbcTemplate jdbc;
  private final byte[] kmsKey;
  private final AppKeyLoadBalancer loadBalancer;

  /** Cache: appKeyId → (ChatClient + ChatModel) pair. */
  private final Cache<UUID, ClientPair> clientCache =
      Caffeine.newBuilder().expireAfterAccess(Duration.ofHours(1)).maximumSize(128).build();

  /** Holds both the ChatClient and the underlying OpenAiChatModel. */
  record ClientPair(ChatClient chatClient, OpenAiChatModel chatModel) {}

  public ChatClientFactory(
      NamedParameterJdbcTemplate jdbc,
      AppKeyLoadBalancer loadBalancer,
      @Value("${codepilot.security.hmac-secret}") String hmacSecret) {
    this.jdbc = jdbc;
    this.loadBalancer = loadBalancer;
    this.kmsKey = deriveKey(hmacSecret);
  }

  // ========================================================================
  // ResolvedClient
  // ========================================================================

  public static class ResolvedClient {
    private final ChatClient chatClient;
    private final OpenAiChatModel chatModel;
    private final UUID appKeyId;
    private final AppKeyLoadBalancer loadBalancer;

    ResolvedClient(
        ChatClient chatClient,
        OpenAiChatModel chatModel,
        UUID appKeyId,
        AppKeyLoadBalancer loadBalancer) {
      this.chatClient = chatClient;
      this.chatModel = chatModel;
      this.appKeyId = appKeyId;
      this.loadBalancer = loadBalancer;
    }

    public ChatClient chatClient() {
      return chatClient;
    }

    public OpenAiChatModel chatModel() {
      return chatModel;
    }

    public boolean isModelGroup() {
      return appKeyId != null;
    }

    public UUID appKeyId() {
      return appKeyId;
    }

    public void startRequest() {
      if (appKeyId != null) loadBalancer.acquire(appKeyId);
    }

    public void endRequest(boolean success, int tokensUsed) {
      if (appKeyId != null) {
        loadBalancer.release(appKeyId);
        if (success) loadBalancer.recordSuccess(appKeyId, tokensUsed);
        else loadBalancer.recordFailure(appKeyId);
      }
    }
  }

  // ========================================================================
  // Resolve methods
  // ========================================================================

  public ResolvedClient resolve(String modelId, ModelSource modelSource, String userId) {
    if (modelId == null || modelId.isBlank()) return buildDefaultResolved();

    UUID id;
    try {
      id = UUID.fromString(modelId);
    } catch (IllegalArgumentException e) {
      return buildDefaultResolved();
    }

    if (modelSource == ModelSource.GROUP) {
      ResolvedClient groupClient = tryResolveModelGroup(id);
      if (groupClient != null) return groupClient;
      return buildDefaultResolved();
    }

    if (modelSource == ModelSource.CUSTOM) {
      ResolvedClient customClient = tryResolveCustomModel(id, userId);
      if (customClient != null) return customClient;
      return buildDefaultResolved();
    }

    // Auto-detect
    ResolvedClient groupClient = tryResolveModelGroup(id);
    if (groupClient != null) return groupClient;
    ResolvedClient customClient = tryResolveCustomModel(id, userId);
    if (customClient != null) return customClient;

    return buildDefaultResolved();
  }

  public ResolvedClient resolve(String modelId, ModelSource modelSource) {
    return resolve(modelId, modelSource, null);
  }

  public ResolvedClient resolve(String modelId) {
    return resolve(modelId, null, null);
  }

  public ChatClient resolveClient(String modelId) {
    return resolve(modelId).chatClient();
  }

  // ========================================================================
  // Model group resolution
  // ========================================================================

  private ResolvedClient tryResolveModelGroup(UUID groupId) {
    String groupSql = "SELECT id, model FROM model_groups WHERE id = :id AND enabled = 1";
    var groupRows =
        jdbc.queryForList(groupSql, new MapSqlParameterSource("id", groupId.toString()));
    if (groupRows.isEmpty()) return null;

    String modelName = (String) groupRows.getFirst().get("model");

    UUID appKeyId = loadBalancer.selectAppKey(groupId);
    if (appKeyId == null) return null;

    ClientPair pair =
        clientCache.get(appKeyId, key -> buildPairFromAppKey(key, modelName, groupId));
    if (pair == null) return null;

    return new ResolvedClient(pair.chatClient(), pair.chatModel(), appKeyId, loadBalancer);
  }

  private ClientPair buildPairFromAppKey(UUID appKeyId, String modelName, UUID groupId) {
    String sql =
        "SELECT base_url, api_key_cipher FROM model_app_keys WHERE id = :id AND enabled = 1";
    var rows = jdbc.queryForList(sql, new MapSqlParameterSource("id", appKeyId.toString()));
    if (rows.isEmpty()) return null;

    var row = rows.getFirst();
    String baseUrl = (String) row.get("base_url");
    byte[] cipher = (byte[]) row.get("api_key_cipher");

    if (baseUrl == null || baseUrl.isBlank()) {
      String groupUrlSql = "SELECT base_url FROM model_groups WHERE id = :groupId";
      var groupRows =
          jdbc.queryForList(groupUrlSql, new MapSqlParameterSource("groupId", groupId.toString()));
      if (!groupRows.isEmpty()) baseUrl = (String) groupRows.getFirst().get("base_url");
    }

    OpenAiChatModel chatModel = buildChatModel(baseUrl, decrypt(cipher), modelName);
    log.info(
        "Built ChatClient [model-group] for groupId={} appKeyId={} model={}",
        groupId,
        appKeyId,
        modelName);
    return new ClientPair(ChatClient.builder(chatModel).build(), chatModel);
  }

  // ========================================================================
  // Custom model resolution
  // ========================================================================

  private ResolvedClient tryResolveCustomModel(UUID providerId, String userId) {
    String sql;
    MapSqlParameterSource params;
    if (userId != null && !userId.isBlank()) {
      sql =
          "SELECT base_url, api_key_cipher, model FROM custom_model_providers WHERE id = :id AND"
              + " user_id = :userId AND enabled = 1";
      params =
          new MapSqlParameterSource()
              .addValue("id", providerId.toString())
              .addValue("userId", userId);
    } else {
      sql =
          "SELECT base_url, api_key_cipher, model FROM custom_model_providers WHERE id = :id AND"
              + " enabled = 1";
      params = new MapSqlParameterSource("id", providerId.toString());
    }
    var rows = jdbc.queryForList(sql, params);
    if (rows.isEmpty()) return null;

    var row = rows.getFirst();
    String baseUrl = (String) row.get("base_url");
    String model = (String) row.get("model");
    byte[] cipher = (byte[]) row.get("api_key_cipher");

    OpenAiChatModel chatModel = buildChatModel(baseUrl, decrypt(cipher), model);
    log.info("Built ChatClient [custom] for provider={} model={}", providerId, model);
    return new ResolvedClient(ChatClient.builder(chatModel).build(), chatModel, null, loadBalancer);
  }

  private ResolvedClient buildDefaultResolved() {
    String sql = "SELECT id FROM model_groups WHERE enabled = 1 ORDER BY sort_order ASC LIMIT 1";
    var rows = jdbc.queryForList(sql, new MapSqlParameterSource());
    if (!rows.isEmpty()) {
      UUID groupId = UUID.fromString((String) rows.getFirst().get("id"));
      ResolvedClient client = tryResolveModelGroup(groupId);
      if (client != null) return client;
    }
    throw new IllegalStateException("No enabled model group configured.");
  }

  // ========================================================================
  // ChatModel builder
  // ========================================================================

  private OpenAiChatModel buildChatModel(String baseUrl, String apiKey, String model) {
    OpenAiApi api = OpenAiApi.builder().baseUrl(baseUrl).apiKey(apiKey).build();
    OpenAiChatOptions opts = OpenAiChatOptions.builder().model(model).build();
    return OpenAiChatModel.builder().openAiApi(api).defaultOptions(opts).build();
  }

  // ========================================================================
  // Crypto
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
      return java.security.MessageDigest.getInstance("SHA-256")
          .digest(secret.getBytes(StandardCharsets.UTF_8));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }
}

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
 *   <li><b>System models</b> — stored in {@code system_model_providers}, each with its own
 *       base_url, api_key, and model name. Available to all users.</li>
 *   <li><b>Custom models</b> — per-user models in {@code custom_model_providers}.</li>
 * </ul>
 *
 * <p>Resolution order: system model → custom model → fallback to first enabled system model.
 * <p>ChatClients are cached in Caffeine to avoid repeated construction on each request.
 */
@Component
public class ChatClientFactory {

  private static final Logger log = LoggerFactory.getLogger(ChatClientFactory.class);

  private final NamedParameterJdbcTemplate jdbc;
  private final byte[] kmsKey;

  /** Cache: modelProviderId → ChatClient (evicts after 1 hour idle). */
  private final Cache<UUID, ChatClient> clientCache =
      Caffeine.newBuilder().expireAfterAccess(Duration.ofHours(1)).maximumSize(128).build();

  public ChatClientFactory(
      NamedParameterJdbcTemplate jdbc,
      @Value("${codepilot.security.hmac-secret}") String hmacSecret) {
    this.jdbc = jdbc;
    this.kmsKey = deriveKey(hmacSecret);
  }

  /**
   * Returns a ChatClient for the given model ID. Resolves in order:
   * 1. System model (from system_model_providers)
   * 2. Custom model (from custom_model_providers)
   * 3. Fallback: first enabled system model by sort_order
   */
  public ChatClient resolve(String modelId) {
    if (modelId == null || modelId.isBlank()) {
      return buildDefaultSystemClient();
    }

    UUID id;
    try {
      id = UUID.fromString(modelId);
    } catch (IllegalArgumentException e) {
      return buildDefaultSystemClient();
    }

    return clientCache.get(id, this::buildClientById);
  }

  private ChatClient buildClientById(UUID providerId) {
    // Try system model first
    ChatClient systemClient = tryBuildSystemClient(providerId);
    if (systemClient != null) return systemClient;

    // Try custom model
    ChatClient customClient = tryBuildCustomClient(providerId);
    if (customClient != null) return customClient;

    // Fallback to default system model
    log.warn("Model provider not found: {}, falling back to default system model", providerId);
    return buildDefaultSystemClient();
  }

  private ChatClient tryBuildSystemClient(UUID providerId) {
    String sql = "SELECT base_url, api_key_cipher, model, timeout_ms FROM system_model_providers WHERE id = :id AND enabled = 1";
    var rows = jdbc.queryForList(sql, new MapSqlParameterSource("id", providerId.toString()));
    if (rows.isEmpty()) return null;

    var row = rows.getFirst();
    return buildClientFromRow(row, "system", providerId);
  }

  private ChatClient tryBuildCustomClient(UUID providerId) {
    String sql = "SELECT base_url, api_key_cipher, model, timeout_ms FROM custom_model_providers WHERE id = :id AND enabled = 1";
    var rows = jdbc.queryForList(sql, new MapSqlParameterSource("id", providerId.toString()));
    if (rows.isEmpty()) return null;

    var row = rows.getFirst();
    return buildClientFromRow(row, "custom", providerId);
  }

  /**
   * Builds a ChatClient for the first enabled system model (used as fallback/default).
   */
  private ChatClient buildDefaultSystemClient() {
    String sql = "SELECT id, base_url, api_key_cipher, model, timeout_ms FROM system_model_providers WHERE enabled = 1 ORDER BY sort_order ASC LIMIT 1";
    var rows = jdbc.queryForList(sql, new MapSqlParameterSource());
    if (rows.isEmpty()) {
      throw new IllegalStateException("No enabled system model configured. Please add at least one system model to system_model_providers table.");
    }
    var row = rows.getFirst();
    UUID id = UUID.fromString((String) row.get("id"));
    return clientCache.get(id, k -> buildClientFromRow(row, "system-default", id));
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
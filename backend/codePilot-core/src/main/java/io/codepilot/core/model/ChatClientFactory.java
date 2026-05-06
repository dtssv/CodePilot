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
 * Resolves a {@link ChatClient} based on the model ID in the request. Supports both the default
 * system model and per-user custom model providers stored in {@code custom_model_providers}.
 *
 * <p>Custom ChatClients are cached in Caffeine to avoid repeated construction on each request.
 */
@Component
public class ChatClientFactory {

  private static final Logger log = LoggerFactory.getLogger(ChatClientFactory.class);

  private final ChatClient.Builder defaultBuilder;
  private final NamedParameterJdbcTemplate jdbc;
  private final byte[] kmsKey;

  /** Cache: modelProviderId → ChatClient (evicts after 1 hour idle). */
  private final Cache<UUID, ChatClient> clientCache =
      Caffeine.newBuilder().expireAfterAccess(Duration.ofHours(1)).maximumSize(64).build();

  public ChatClientFactory(
      ChatClient.Builder defaultBuilder,
      NamedParameterJdbcTemplate jdbc,
      @Value("${codepilot.security.hmac-secret}") String hmacSecret) {
    this.defaultBuilder = defaultBuilder;
    this.jdbc = jdbc;
    this.kmsKey = deriveKey(hmacSecret);
  }

  /** Returns the default ChatClient (configured via application.yml). */
  public ChatClient defaultClient() {
    return defaultBuilder.build();
  }

  /**
   * Returns a ChatClient for the given model provider ID. Falls back to default if modelId is null
   * or not found.
   */
  public ChatClient resolve(String modelId) {
    if (modelId == null || modelId.isBlank()) return defaultClient();
    UUID id;
    try {
      id = UUID.fromString(modelId);
    } catch (IllegalArgumentException e) {
      return defaultClient();
    }

    return clientCache.get(id, this::buildCustomClient);
  }

  private ChatClient buildCustomClient(UUID providerId) {
    String sql =
        "SELECT base_url, api_key_cipher, model, timeout_ms FROM custom_model_providers WHERE id = :id AND enabled = true";
    var rows = jdbc.queryForList(sql, new MapSqlParameterSource("id", providerId.toString()));
    if (rows.isEmpty()) return defaultClient();

    var row = rows.getFirst();
    String baseUrl = (String) row.get("base_url");
    byte[] cipher = (byte[]) row.get("api_key_cipher");
    String model = (String) row.get("model");
    int timeout = (Integer) row.get("timeout_ms");

    String apiKey = decrypt(cipher);
    OpenAiApi api = new OpenAiApi(baseUrl, apiKey);
    OpenAiChatOptions opts = OpenAiChatOptions.builder().withModel(model).build();
    OpenAiChatModel chatModel = new OpenAiChatModel(api, opts);

    log.info("Built custom ChatClient for provider={} model={}", providerId, model);
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
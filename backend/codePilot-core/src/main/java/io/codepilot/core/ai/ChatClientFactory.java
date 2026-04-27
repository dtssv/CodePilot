package io.codepilot.core.ai;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import java.time.Duration;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.ai.openai.api.OpenAiApi;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Factory for creating and caching {@link ChatClient} instances.
 *
 * <p>Provides:
 * <ul>
 *   <li>A default ChatClient built from the primary Spring AI config (OpenAI).</li>
 *   <li>Dynamic ChatClients for custom models, cached with Caffeine (TTL 30min, max 50 entries).</li>
 * </ul>
 */
@Configuration
public class ChatClientFactory {

  private static final Logger LOG = LoggerFactory.getLogger(ChatClientFactory.class);

  /** Cache: modelId → ChatClient for custom models. */
  private final Cache<String, ChatClient> customClientCache = Caffeine.newBuilder()
      .maximumSize(50)
      .expireAfterAccess(Duration.ofMinutes(30))
      .removalListener((key, value, cause) ->
          LOG.debug("Evicted custom ChatClient for modelId={}, cause={}", key, cause))
      .build();

  /** The default ChatClient bean — used for built-in models. */
  private volatile ChatClient defaultChatClient;

  public ChatClientFactory() {
    // defaultChatClient is set via @Bean method below
  }

  /**
   * Creates the default ChatClient bean from the primary OpenAI configuration.
   *
   * <p>Safety guardrails (redaction, leak detection) are applied by
   * {@link SafeguardAdvisor} before the prompt reaches ChatClient.
   */
  @Bean
  ChatClient defaultChatClient(OpenAiChatModel chatModel) {
    this.defaultChatClient = ChatClient.builder(chatModel).build();
    return this.defaultChatClient;
  }

  /** Returns the default ChatClient (for built-in models). */
  public ChatClient getDefaultChatClient() {
    return defaultChatClient;
  }

  /**
   * Returns (or creates) a ChatClient for the given custom model parameters.
   *
   * <p>The client is cached by modelId. If the model config changes (update),
   * call {@link #evictCustomClient(String)} first.
   *
   * @param modelId    Unique identifier for the custom model (e.g. "u-1").
   * @param baseUrl    Provider base URL.
   * @param apiKey     Decrypted API key.
   * @param model      Model name (e.g. "gpt-4o").
   * @param headers    Extra headers (currently not used by Spring AI OpenAI; logged for future).
   * @param timeoutMs  Request timeout in milliseconds.
   */
  public ChatClient getOrCreateCustomClient(
      String modelId, String baseUrl, String apiKey, String model,
      Map<String, String> headers, Integer timeoutMs) {
    return customClientCache.get(modelId, id -> {
      LOG.info("Creating new ChatClient for custom model: id={}, model={}, baseUrl={}",
          id, model, baseUrl);

      var api = OpenAiApi.builder()
          .baseUrl(baseUrl)
          .apiKey(apiKey)
          .build();

      var options = OpenAiChatOptions.builder()
          .model(model)
          .build();

      var chatModel = OpenAiChatModel.builder()
          .openAiApi(api)
          .defaultOptions(options)
          .build();

      if (headers != null && !headers.isEmpty()) {
        LOG.debug("Custom model {} has extra headers: {} (not yet applied to Spring AI client)",
            modelId, headers.keySet());
        // TODO: When Spring AI supports custom headers on OpenAiApi, apply them here.
      }

      return ChatClient.builder(chatModel).build();
    });
  }

  /** Evicts a cached ChatClient for the given modelId (e.g. after update or delete). */
  public void evictCustomClient(String modelId) {
    customClientCache.invalidate(modelId);
    LOG.info("Evicted ChatClient cache for modelId={}", modelId);
  }
}
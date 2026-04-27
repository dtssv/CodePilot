package io.codepilot.core.model;

import io.codepilot.common.model.BuiltinModel;
import io.codepilot.common.model.CustomModel;
import io.codepilot.common.model.ModelListResponse;
import io.codepilot.common.model.ModelTestRequest;
import io.codepilot.common.model.ModelTestResult;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.ai.openai.api.OpenAiApi;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/**
 * Service for managing models: built-in models from config + custom models from DB.
 *
 * <p>Also responsible for testing model connectivity and building ChatClient instances
 * for custom models on demand (cached via {@link ChatClientFactory}).
 */
@Service
@EnableConfigurationProperties(BuiltinModelsProperties.class)
public class ModelService {

  private static final Logger LOG = LoggerFactory.getLogger(ModelService.class);

  private final BuiltinModelsProperties builtinProps;
  private final CustomModelRepository customModelRepo;
  private final ApiKeyEncryptor encryptor;
  private final ChatClientFactory chatClientFactory;

  public ModelService(
      BuiltinModelsProperties builtinProps,
      CustomModelRepository customModelRepo,
      ApiKeyEncryptor encryptor,
      ChatClientFactory chatClientFactory) {
    this.builtinProps = builtinProps;
    this.customModelRepo = customModelRepo;
    this.encryptor = encryptor;
    this.chatClientFactory = chatClientFactory;
  }

  // ---- List ----

  /** Returns all models (built-in + custom) for a given user. */
  public Mono<ModelListResponse> listModels(String userId) {
    var builtinModels = builtinProps.getModels().stream()
        .map(p -> new BuiltinModel(p.getId(), p.getName(), p.getCaps(), p.getMaxTokens()))
        .toList();

    return customModelRepo.findByUserId(userId)
        .map(entities -> {
          var customModels = entities.stream()
              .map(this::toCustomModel)
              .toList();
          return new ModelListResponse(builtinModels, customModels);
        });
  }

  // ---- Create ----

  public Mono<CustomModel> createCustomModel(String userId, CustomModel request) {
    String apiKeyEnc = encryptor.encrypt(request.apiKey());
    var entity = new CustomModelEntity(
        null, userId, request.name(), request.protocol(),
        request.baseUrl(), apiKeyEnc, request.model(),
        request.headers(), request.timeoutMs(),
        request.caps(), request.maxTokens(),
        Instant.now(), Instant.now());

    return customModelRepo.insert(entity)
        .flatMap(id -> customModelRepo.findByIdAndUserId(id, userId))
        .map(this::toCustomModel);
  }

  // ---- Update ----

  public Mono<CustomModel> updateCustomModel(String userId, long id, CustomModel request) {
    return customModelRepo.findByIdAndUserId(id, userId)
        .flatMap(existing -> {
          // If apiKey is provided, re-encrypt; otherwise keep existing
          String apiKeyEnc = existing.apiKeyEnc();
          if (request.apiKey() != null && !request.apiKey().isBlank()) {
            apiKeyEnc = encryptor.encrypt(request.apiKey());
          }
          var updated = new CustomModelEntity(
              id, userId, request.name(), request.protocol(),
              request.baseUrl(), apiKeyEnc, request.model(),
              request.headers(), request.timeoutMs(),
              request.caps(), request.maxTokens(),
              existing.createdAt(), Instant.now());
          return customModelRepo.update(id, userId, updated).thenReturn(updated);
        })
        .map(this::toCustomModel);
  }

  // ---- Delete ----

  public Mono<Boolean> deleteCustomModel(String userId, long id) {
    return customModelRepo.deleteByIdAndUserId(id, userId)
        .doOnNext(deleted -> {
          if (deleted) {
            chatClientFactory.evictCustomClient("u-" + id);
          }
        });
  }

  // ---- Test connectivity ----

  /** Tests connectivity to a model provider before saving. */
  public Mono<ModelTestResult> testModel(ModelTestRequest request) {
    return Mono.fromCallable(() -> {
      try {
        var api = OpenAiApi.builder()
            .baseUrl(request.baseUrl())
            .apiKey(request.apiKey())
            .build();

        var options = OpenAiChatOptions.builder()
            .model(request.model())
            .temperature(0.0)
            .build();

        var chatModel = OpenAiChatModel.builder()
            .openAiApi(api)
            .defaultOptions(options)
            .build();

        long start = System.currentTimeMillis();
        String response = ChatClient.builder(chatModel).build()
            .prompt()
            .user("Say 'hello' in one word.")
            .call()
            .content();
        long latency = System.currentTimeMillis() - start;

        return ModelTestResult.success(latency, truncate(response, 200));
      } catch (Exception e) {
        LOG.warn("Model test failed for {} at {}: {}", request.model(), request.baseUrl(), e.getMessage());
        return ModelTestResult.failure(e.getMessage());
      }
    }).subscribeOn(reactor.core.scheduler.Schedulers.boundedElastic());
  }

  // ---- Resolve ChatClient for a modelId ----

  /**
   * Resolves a ChatClient for the given modelId.
   *
   * <p>For built-in models (matched by id in config), returns the default ChatClient.
   * For custom models (id starts with "u-"), builds/caches a ChatClient from the DB record.
   *
   * @return the ChatClient, or the default if the modelId is unknown.
   */
  public Mono<ChatClient> resolveChatClient(String modelId, String userId) {
    // Built-in model → default client
    boolean isBuiltin = builtinProps.getModels().stream()
        .anyMatch(m -> m.getId().equals(modelId));
    if (isBuiltin) {
      return Mono.just(chatClientFactory.getDefaultChatClient());
    }

    // Custom model → dynamic client
    if (modelId != null && modelId.startsWith("u-")) {
      long numericId = Long.parseLong(modelId.substring(2));
      return customModelRepo.findByIdAndUserId(numericId, userId)
          .map(entity -> {
            String apiKey = encryptor.decrypt(entity.apiKeyEnc());
            return chatClientFactory.getOrCreateCustomClient(modelId, entity.baseUrl(),
                apiKey, entity.model(), entity.headers(), entity.timeoutMs());
          })
          .switchIfEmpty(Mono.just(chatClientFactory.getDefaultChatClient()));
    }

    // Fallback to default
    return Mono.just(chatClientFactory.getDefaultChatClient());
  }

  // ---- Mapping ----

  private CustomModel toCustomModel(CustomModelEntity entity) {
    return new CustomModel(
        "u-" + entity.id(),
        entity.name(),
        entity.protocol(),
        entity.baseUrl(),
        ApiKeyEncryptor.mask("placeholder"), // Never expose real key
        null, // apiKey never returned in GET
        entity.model(),
        entity.headers(),
        entity.timeoutMs(),
        entity.caps(),
        entity.maxTokens());
  }

  private String truncate(String text, int max) {
    if (text == null) return null;
    return text.length() <= max ? text : text.substring(0, max) + "...";
  }
}
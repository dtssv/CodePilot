package io.codepilot.core.conversation;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.conversation.ToolResultBus.ToolResultEvent;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.connection.ReactiveRedisConnectionFactory;
import org.springframework.data.redis.core.ReactiveRedisTemplate;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.PatternTopic;
import org.springframework.data.redis.listener.ReactiveRedisMessageListenerContainer;
import org.springframework.data.redis.serializer.RedisSerializationContext;
import org.springframework.data.redis.serializer.StringRedisSerializer;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Bridges plugin-side {@code POST /v1/conversation/tool-result} calls back to the in-flight
 * {@code POST /v1/conversation/run} stream that issued the {@code tool_call}.
 *
 * <p>Two delivery mechanisms work together:
 * <ol>
 *   <li><b>CompletableFuture</b> (primary) — in-process direct delivery. The waiting thread
 *       registers a future via {@link #registerFuture} before emitting the tool_call SSE, and
 *       the HTTP handler completes it via {@link #publish}.</li>
 *   <li><b>Redis Pub/Sub</b> (secondary) — for cross-replica delivery when multiple backend
 *       instances are running. The constructor auto-subscribes to the Redis channel pattern
 *       and bridges incoming messages to the in-process CompletableFuture registry.</li>
 * </ol>
 *
 * <p>In a single-instance deployment, mechanism 1 alone suffices. In a cluster, the plugin's
 * HTTP POST may land on replica B while the waiting GatherAction runs on replica A. In that
 * case, replica B publishes to Redis, replica A receives it via the auto-bridge, and the
 * CompletableFuture on replica A is completed.
 */
@Component
public class ToolResultBus {

  private static final Logger log = LoggerFactory.getLogger(ToolResultBus.class);

  private final ReactiveRedisTemplate<String, String> template;
  private final ReactiveRedisMessageListenerContainer container;
  private final ObjectMapper mapper;

  /**
   * In-process CompletableFuture registry: key = "sessionId:toolCallId".
   * The waiting thread registers a future before emitting the tool_call SSE event,
   * and the HTTP handler completes it when the client posts the result.
   */
  private static final ConcurrentHashMap<String, CompletableFuture<ToolResultEvent>> PENDING_FUTURES =
      new ConcurrentHashMap<>();

  /** Channel prefix for Redis Pub/Sub. */
  private static final String CHANNEL_PREFIX = "codepilot:tool-result:";

  public ToolResultBus(
      ReactiveRedisConnectionFactory connectionFactory,
      ReactiveRedisMessageListenerContainer container,
      ObjectMapper mapper) {
    var serializer = new StringRedisSerializer();
    var ctx =
        RedisSerializationContext.<String, String>newSerializationContext(serializer)
            .key(serializer)
            .value(serializer)
            .hashKey(serializer)
            .hashValue(serializer)
            .build();
    this.template = new ReactiveRedisTemplate<>(connectionFactory, ctx);
    this.container = container;
    this.mapper = mapper;

    // Auto-subscribe to the Redis tool-result channel pattern and bridge
    // incoming messages to in-process CompletableFuture instances.
    // This is essential in cluster environments where the HTTP POST from the
    // plugin may land on a different replica than the one running GatherAction.
    subscribeAndBridge();
  }

  // ─── CompletableFuture API (primary, in-process) ──────────────────────

  /** Registers a pending future for a specific toolCall within a session. */
  public static CompletableFuture<ToolResultEvent> registerFuture(String sessionId, String toolCallId) {
    String key = futureKey(sessionId, toolCallId);
    var future = new CompletableFuture<ToolResultEvent>();
    PENDING_FUTURES.put(key, future);
    log.info("ToolResultBus: registered future for key={}", key);
    return future;
  }

  /** Removes a pending future (e.g., on timeout or cleanup). */
  public static void unregisterFuture(String sessionId, String toolCallId) {
    PENDING_FUTURES.remove(futureKey(sessionId, toolCallId));
  }

  /** Convenience: register + block with timeout. */
  public static ToolResultEvent awaitResult(String sessionId, String toolCallId, Duration timeout) {
    var future = registerFuture(sessionId, toolCallId);
    try {
      return future.get(timeout.toMillis(), java.util.concurrent.TimeUnit.MILLISECONDS);
    } catch (Exception e) {
      unregisterFuture(sessionId, toolCallId);
      if (e instanceof java.util.concurrent.TimeoutException) {
        log.warn("ToolResultBus: timeout waiting for toolCallId={} in session={}", toolCallId, sessionId);
      } else {
        log.warn("ToolResultBus: error waiting for toolCallId={} in session={}", toolCallId, sessionId, e);
      }
      return null;
    }
  }

  private static String futureKey(String sessionId, String toolCallId) {
    return sessionId + ":" + toolCallId;
  }

  private static String sessionIdFromChannel(String channel) {
    if (channel == null || !channel.startsWith(CHANNEL_PREFIX)) {
      return null;
    }
    String sessionId = channel.substring(CHANNEL_PREFIX.length());
    return sessionId.isBlank() ? null : sessionId;
  }

  // ─── Publish (called by ToolResultController) ──────────────────────────

  /**
   * Publishes a tool result. Completes in-process futures first, then publishes to Redis
   * for cross-replica delivery.
   *
   * <p>The {@code future.complete(event)} call happens synchronously before the Mono is
   * returned, so the caller does not need to subscribe to the Mono for in-process delivery
   * to work. However, the Redis publish is lazy and requires the Mono to be subscribed.
   */
  public Mono<Long> publish(String sessionId, ToolResultEvent event) {
    // 1. Complete in-process future (primary — reliable, no network)
    String key = futureKey(sessionId, event.toolCallId());
    var future = PENDING_FUTURES.remove(key);
    if (future != null) {
      log.info("ToolResultBus: completing future for key={}", key);
      future.complete(event);
    } else {
      log.info("ToolResultBus: no pending future for key={}, publishing to Redis only", key);
    }

    // 2. Publish to Redis for cross-replica delivery
    String channel = channel(sessionId);
    String body;
    try {
      body = mapper.writeValueAsString(event);
    } catch (JsonProcessingException e) {
      return Mono.error(e);
    }
    return template.convertAndSend(channel, body)
        .doOnNext(n -> log.debug("ToolResultBus: Redis published to channel={}, receivers={}", channel, n))
        .doOnError(e -> log.warn("ToolResultBus: Redis publish failed for session={}", sessionId, e))
        .onErrorResume(e -> Mono.just(0L)); // Don't fail the HTTP response if Redis is down
  }

  // ─── Redis auto-bridge (cross-replica) ────────────────────────────────

  /**
   * Subscribes to the Redis channel pattern {@code codepilot:tool-result:*} and bridges
   * incoming messages to in-process CompletableFuture instances.
   *
   * <p>This handles the cluster scenario: replica B receives the HTTP POST from the plugin
   * and publishes to Redis; replica A (running GatherAction) receives the Redis message
   * and completes the waiting CompletableFuture.
   */
  private void subscribeAndBridge() {
    PatternTopic topic = new PatternTopic(CHANNEL_PREFIX + "*");
    container.receive(topic)
        .subscribe(
            message -> {
              String channel = message.getChannel();
              String sessionId = sessionIdFromChannel(channel);
              if (sessionId == null) {
                log.warn("ToolResultBus: Redis bridge ignored message on channel={}", channel);
                return;
              }
              ToolResultEvent event;
              try {
                event = parse(message.getMessage());
              } catch (Exception e) {
                log.warn("ToolResultBus: Redis bridge bad payload on channel={}", channel, e);
                return;
              }
              String key = futureKey(sessionId, event.toolCallId());
              var oldFuture = PENDING_FUTURES.remove(key);
              if (oldFuture != null && !oldFuture.isDone()) {
                oldFuture.complete(event);
                log.info("ToolResultBus: Redis bridge completed future for key={}", key);
              } else {
                log.debug(
                    "ToolResultBus: Redis bridge: no pending future for key={} (toolCallId={})",
                    key,
                    event.toolCallId());
              }
            },
            error -> log.error("ToolResultBus: Redis bridge subscription error", error)
        );
    log.info("ToolResultBus: Redis auto-bridge subscribed to channel pattern {}*", CHANNEL_PREFIX);
  }

  // ─── Redis subscribe (legacy API, kept for backward compatibility) ─────

  /** Subscribes to the result channel for a single session via Redis. */
  public Flux<ToolResultEvent> subscribe(String sessionId) {
    ChannelTopic topic = new ChannelTopic(channel(sessionId));
    return container
        .receive(topic)
        .map(message -> message.getMessage())
        .timeout(Duration.ofMinutes(10))
        .map(this::parse)
        .doOnError(e -> log.warn("ToolResultBus.subscribe error", e));
  }

  private ToolResultEvent parse(String json) {
    try {
      return mapper.readValue(json, ToolResultEvent.class);
    } catch (Exception e) {
      throw new RuntimeException("Bad tool result event", e);
    }
  }

  private static String channel(String sessionId) {
    return CHANNEL_PREFIX + sessionId;
  }

  /** Wire-format for events flowing through the bus. */
  public record ToolResultEvent(
      String toolCallId,
      boolean ok,
      Object result,
      String errorCode,
      String errorMessage,
      long durationMs) {}
}
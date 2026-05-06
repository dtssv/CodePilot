package io.codepilot.core.conversation;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.conversation.ToolResultBus.ToolResultEvent;
import java.time.Duration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.connection.ReactiveRedisConnectionFactory;
import org.springframework.data.redis.core.ReactiveRedisTemplate;
import org.springframework.data.redis.listener.ChannelTopic;
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
 * <p>Implemented over Redis Pub/Sub so multiple backend replicas can serve the result side
 * regardless of which replica owns the run. Channel name: {@code tool-result:{sessionId}}.
 */
@Component
public class ToolResultBus {

  private static final Logger log = LoggerFactory.getLogger(ToolResultBus.class);

  private final ReactiveRedisTemplate<String, String> template;
  private final ReactiveRedisMessageListenerContainer container;
  private final ObjectMapper mapper;

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
  }

  /** Publishes a tool result; the run side will pick it up via {@link #subscribe(String)}. */
  public Mono<Long> publish(String sessionId, ToolResultEvent event) {
    String channel = channel(sessionId);
    String body;
    try {
      body = mapper.writeValueAsString(event);
    } catch (JsonProcessingException e) {
      return Mono.error(e);
    }
    return template.convertAndSend(channel, body);
  }

  /** Subscribes to the result channel for a single session. */
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
    return "codepilot:tool-result:" + sessionId;
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
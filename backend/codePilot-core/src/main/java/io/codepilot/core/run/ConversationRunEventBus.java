package io.codepilot.core.run;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.data.redis.connection.ReactiveRedisConnectionFactory;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.ReactiveRedisMessageListenerContainer;
import org.springframework.data.redis.serializer.RedisSerializationContext;
import org.springframework.data.redis.serializer.StringRedisSerializer;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/** Redis pub/sub fan-out for durable run SSE events (cross-pod attach). */
@Component
public class ConversationRunEventBus {

  private static final String CHANNEL_PREFIX = "codepilot:run:events:";

  private final ReactiveStringRedisTemplate template;
  private final ReactiveRedisMessageListenerContainer container;
  private final ObjectMapper mapper;
  private final boolean redisAvailable;

  public ConversationRunEventBus(
      ObjectProvider<ReactiveRedisConnectionFactory> connectionFactoryProvider,
      ObjectMapper mapper) {
    this.mapper = mapper;
    ReactiveRedisConnectionFactory connectionFactory = connectionFactoryProvider.getIfAvailable();
    this.redisAvailable = connectionFactory != null;
    if (redisAvailable) {
      var serializer = new StringRedisSerializer();
      var ctx =
          RedisSerializationContext.<String, String>newSerializationContext(serializer)
              .key(serializer)
              .value(serializer)
              .build();
      this.template = new ReactiveStringRedisTemplate(connectionFactory, ctx);
      this.container = new ReactiveRedisMessageListenerContainer(connectionFactory);
    } else {
      this.template = null;
      this.container = null;
    }
  }

  public Mono<Long> publish(String runId, int seq, ServerSentEvent<String> event) {
    if (!redisAvailable) {
      return Mono.just(0L);
    }
    try {
      String json =
          mapper.writeValueAsString(new RunEventMessage(seq, event.event(), event.data()));
      return template.convertAndSend(channel(runId), json);
    } catch (JsonProcessingException e) {
      return Mono.error(e);
    }
  }

  public Flux<RunEventMessage> subscribe(String runId, int afterSeq) {
    if (!redisAvailable) {
      return Flux.empty();
    }
    return container
        .receive(new ChannelTopic(channel(runId)))
        .map(m -> m.getMessage())
        .mapNotNull(
            json -> {
              try {
                return mapper.readValue(json, RunEventMessage.class);
              } catch (Exception e) {
                return null;
              }
            })
        .filter(msg -> msg.seq() > afterSeq);
  }

  private static String channel(String runId) {
    return CHANNEL_PREFIX + runId;
  }

  public record RunEventMessage(int seq, String eventName, String payloadJson) {
    public ServerSentEvent<String> toSse() {
      return ServerSentEvent.<String>builder().event(eventName).data(payloadJson).build();
    }
  }
}

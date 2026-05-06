package io.codepilot.core.conversation;

import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.ReactiveRedisMessageListenerContainer;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Cluster-wide stop signal for in-flight {@code /v1/conversation/run} streams. Any replica that
 * receives {@code POST /v1/conversation/stop} publishes here; the replica owning the SSE stream
 * cancels its inner pipeline.
 */
@Component
public class StopSignalBus {

  private final ReactiveStringRedisTemplate redis;
  private final ReactiveRedisMessageListenerContainer container;

  public StopSignalBus(
      ReactiveStringRedisTemplate redis, ReactiveRedisMessageListenerContainer container) {
    this.redis = redis;
    this.container = container;
  }

  public Mono<Long> stop(String sessionId) {
    return redis.convertAndSend(channel(sessionId), "stop");
  }

  public Flux<String> subscribe(String sessionId) {
    return container
        .receive(new ChannelTopic(channel(sessionId)))
        .map(m -> m.getMessage());
  }

  private static String channel(String sessionId) {
    return "codepilot:stop:" + sessionId;
  }
}
package io.codepilot.core.conversation;

import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.ReactiveRedisConnectionFactory;
import org.springframework.data.redis.listener.ReactiveRedisMessageListenerContainer;

/** Shared Pub/Sub listener container, backing the tool-result bus. */
@Configuration
public class ReactiveRedisListenerConfig {

  @Bean
  @ConditionalOnMissingBean
  public ReactiveRedisMessageListenerContainer reactiveRedisMessageListenerContainer(
      ReactiveRedisConnectionFactory factory) {
    return new ReactiveRedisMessageListenerContainer(factory);
  }
}
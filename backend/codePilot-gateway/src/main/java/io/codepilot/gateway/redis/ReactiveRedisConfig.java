package io.codepilot.gateway.redis;

import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.ReactiveRedisConnectionFactory;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;
import org.springframework.data.redis.serializer.RedisSerializationContext;
import org.springframework.data.redis.serializer.StringRedisSerializer;

/**
 * Ensures a {@link ReactiveStringRedisTemplate} is available for string-keyed caches (nonce
 * blacklists, rate-limit counters, short-lived session digests).
 */
@Configuration
public class ReactiveRedisConfig {

  @Bean
  @ConditionalOnMissingBean
  public ReactiveStringRedisTemplate reactiveStringRedisTemplate(
      ReactiveRedisConnectionFactory connectionFactory) {
    var serializer = new StringRedisSerializer();
    RedisSerializationContext<String, String> context =
        RedisSerializationContext.<String, String>newSerializationContext(serializer)
            .key(serializer)
            .value(serializer)
            .hashKey(serializer)
            .hashValue(serializer)
            .build();
    return new ReactiveStringRedisTemplate(connectionFactory, context);
  }
}
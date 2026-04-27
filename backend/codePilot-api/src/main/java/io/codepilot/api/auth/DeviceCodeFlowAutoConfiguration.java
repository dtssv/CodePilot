package io.codepilot.api.auth;

import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.data.redis.core.ReactiveStringRedisTemplate;

/**
 * Auto-configuration for the Device Code Flow service. Only activated when OIDC is configured
 * (since Device Code Flow is an OIDC extension per RFC 8628).
 */
@AutoConfiguration
@ConditionalOnProperty(prefix = "codepilot.security.sso.oidc", name = "issuer-uri")
public class DeviceCodeFlowAutoConfiguration {

  @Bean
  public DeviceCodeFlowService deviceCodeFlowService(
      OidcProperties oidcProps, ReactiveStringRedisTemplate redis) {
    return new DeviceCodeFlowService(oidcProps, redis);
  }

  @Bean
  public JwksCacheService jwksCacheService(OidcProperties oidcProps) {
    return new JwksCacheService(oidcProps);
  }
}
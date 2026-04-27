package io.codepilot.gateway.security;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.web.server.SecurityWebFilterChain;

/**
 * Spring Security here is purely opt-out: we authenticate via our own {@code JwtAuthWebFilter} and
 * {@code HmacSignatureWebFilter}, both of which write a uniform error envelope on failure.
 *
 * <p>This config disables CSRF (we use HMAC signatures), opens HTTP basic, and explicitly permits
 * everything so that our own filters become the single source of truth for authorisation.
 */
@Configuration
@EnableWebFluxSecurity
public class WebSecurityConfig {

  @Bean
  public SecurityWebFilterChain springSecurityFilterChain(ServerHttpSecurity http) {
    return http.csrf(ServerHttpSecurity.CsrfSpec::disable)
        .httpBasic(ServerHttpSecurity.HttpBasicSpec::disable)
        .formLogin(ServerHttpSecurity.FormLoginSpec::disable)
        .logout(ServerHttpSecurity.LogoutSpec::disable)
        .authorizeExchange(exchanges -> exchanges.anyExchange().permitAll())
        .build();
  }
}
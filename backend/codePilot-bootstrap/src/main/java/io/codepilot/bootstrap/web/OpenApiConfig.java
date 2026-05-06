package io.codepilot.bootstrap.web;

import org.springdoc.core.models.GroupedOpenApi;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Springdoc GroupedOpenApi configuration for all API groups. */
@Configuration
public class OpenApiConfig {

  @Bean
  public GroupedOpenApi chatGroup() {
    return GroupedOpenApi.builder().group("chat").pathsToMatch("/v1/conversation/**").build();
  }

  @Bean
  public GroupedOpenApi agentGroup() {
    return GroupedOpenApi.builder()
        .group("agent")
        .pathsToMatch("/v1/conversation/**", "/v1/tool-result/**")
        .build();
  }

  @Bean
  public GroupedOpenApi mcpGroup() {
    return GroupedOpenApi.builder().group("mcp").pathsToMatch("/v1/mcp/**").build();
  }

  @Bean
  public GroupedOpenApi authGroup() {
    return GroupedOpenApi.builder().group("auth").pathsToMatch("/v1/auth/**").build();
  }

  @Bean
  public GroupedOpenApi pluginGroup() {
    return GroupedOpenApi.builder()
        .group("plugin")
        .pathsToMatch("/v1/plugin/**")
        .build();
  }

  @Bean
  public GroupedOpenApi ragGroup() {
    return GroupedOpenApi.builder().group("rag").pathsToMatch("/v1/rag/**").build();
  }

  @Bean
  public GroupedOpenApi sessionGroup() {
    return GroupedOpenApi.builder().group("session").pathsToMatch("/v1/session/**").build();
  }

  @Bean
  public GroupedOpenApi modelGroup() {
    return GroupedOpenApi.builder().group("model").pathsToMatch("/v1/models/**").build();
  }
}
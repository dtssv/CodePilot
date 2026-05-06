package io.codepilot.bootstrap.web;

import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestClient;

/**
 * Provides a {@link RestClient.Builder} bean required by Spring AI's OpenAI auto-configuration.
 *
 * <p>In a pure WebFlux application ({@code web-application-type=reactive}), Spring Boot does not
 * auto-configure {@code RestClient.Builder}. This config fills the gap so that
 * {@code OpenAiAutoConfiguration} can bootstrap normally.
 */
@Configuration
public class RestClientConfig {

    @Bean
    @ConditionalOnMissingBean
    public RestClient.Builder restClientBuilder() {
        return RestClient.builder();
    }
}
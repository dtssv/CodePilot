package io.codepilot.core.model;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Registers a default {@link ChatClient} bean built from the auto-configured
 * {@link ChatClient.Builder}. Required by graph actions and session service
 * that inject {@code ChatClient} directly.
 *
 * <p>In Spring AI 1.0.0, {@code ChatClient} is no longer auto-configured as a
 * bean — only {@code ChatClient.Builder} is. This bridge keeps existing code
 * working without changing every injection site.
 */
@Configuration
public class ChatClientConfig {

    @Bean
    public ChatClient chatClient(ChatClient.Builder builder) {
        return builder.build();
    }
}
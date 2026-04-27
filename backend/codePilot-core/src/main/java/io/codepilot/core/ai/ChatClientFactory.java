package io.codepilot.core.ai;

import io.codepilot.core.safety.RedactionService;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Builds the default {@link ChatClient} used by the conversation service.
 *
 * <p>For M3, we wire the Spring AI OpenAI provider with a custom SafeguardAdvisor that applies
 * redaction before sending to the model and leak detection on the response.
 */
@Configuration
public class ChatClientFactory {

  private final RedactionService redactionService;

  public ChatClientFactory(RedactionService redactionService) {
    this.redactionService = redactionService;
  }

  @Bean
  ChatClient defaultChatClient(OpenAiChatModel chatModel) {
    return ChatClient.builder(chatModel)
        .defaultAdvisors(new SafeguardAdvisor(redactionService))
        .build();
  }
}
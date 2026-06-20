package io.codepilot.core.session.context;

import io.codepilot.core.model.ChatClientFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ContextConfig {

  @Bean
  public ContextBudget contextBudget() {
    return new ContextBudget(128_000);
  }

  @Bean
  public ContextCompactor contextCompactor(
      ContextBudget budget, ChatClientFactory chatClientFactory) {
    return new ContextCompactor(budget, chatClientFactory);
  }
}

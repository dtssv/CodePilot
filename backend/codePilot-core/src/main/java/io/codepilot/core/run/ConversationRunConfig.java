package io.codepilot.core.run;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Configuration
@EnableConfigurationProperties(ConversationRunProperties.class)
public class ConversationRunConfig {}

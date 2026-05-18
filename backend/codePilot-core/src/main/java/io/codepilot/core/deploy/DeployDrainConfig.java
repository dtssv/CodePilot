package io.codepilot.core.deploy;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Configuration
@EnableConfigurationProperties(DeployDrainProperties.class)
@ConditionalOnProperty(prefix = "codepilot.deploy.drain", name = "enabled", havingValue = "true", matchIfMissing = true)
public class DeployDrainConfig {}

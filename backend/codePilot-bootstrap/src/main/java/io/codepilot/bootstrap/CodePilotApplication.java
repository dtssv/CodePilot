package io.codepilot.bootstrap;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Single entry point for CodePilot backend. Scans the entire
 * {@code io.codepilot} root so all
 * modules contribute beans automatically.
 */
@SpringBootApplication(scanBasePackages = "io.codepilot")
@ConfigurationPropertiesScan("io.codepilot")
@EnableScheduling
public class CodePilotApplication {

    public static void main(String[] args) {
        SpringApplication.run(CodePilotApplication.class, args);
    }
}
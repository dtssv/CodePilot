package io.codepilot.bootstrap;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Base class for integration tests. Spins up real Postgres (with pgvector) and Redis via
 * Testcontainers. Spring Boot context auto-configures Flyway migrations against the test DB.
 *
 * <p>All test classes that extend this can call the running backend through {@code WebTestClient}
 * or direct bean injection.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers
public abstract class IntegrationTestBase {

  @Container
  static PostgreSQLContainer<?> postgres =
      new PostgreSQLContainer<>("pgvector/pgvector:pg16")
          .withDatabaseName("codepilot_test")
          .withUsername("test")
          .withPassword("test");

  @Container
  static GenericContainer<?> redis =
      new GenericContainer<>("redis:7-alpine").withExposedPorts(6379);

  @DynamicPropertySource
  static void configure(DynamicPropertyRegistry registry) {
    registry.add("spring.datasource.url", postgres::getJdbcUrl);
    registry.add("spring.datasource.username", postgres::getUsername);
    registry.add("spring.datasource.password", postgres::getPassword);
    registry.add(
        "spring.data.redis.url",
        () -> "redis://" + redis.getHost() + ":" + redis.getMappedPort(6379));
    // LLM: use WireMock or a pass-through stub so tests don't call a real provider.
    registry.add("spring.ai.openai.base-url", () -> "http://localhost:19999");
    registry.add("spring.ai.openai.api-key", () -> "test-api-key");
    registry.add("spring.ai.openai.chat.options.model", () -> "test-model");
    // Security
    registry.add(
        "codepilot.security.jwt-secret",
        () -> "01234567890123456789012345678901"); // 32 bytes
    registry.add(
        "codepilot.security.hmac-secret",
        () -> "01234567890123456789012345678901");
    registry.add("codepilot.security.sso.dev.enabled", () -> "true");
    registry.add(
        "codepilot.security.sso.dev.token",
        () -> "test-dev-token-16ch");
    // Activate dev profile so DevSsoVerifier is usable.
    registry.add("spring.profiles.active", () -> "dev");
  }
}
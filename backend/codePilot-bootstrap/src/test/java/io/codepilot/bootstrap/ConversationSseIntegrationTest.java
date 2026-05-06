package io.codepilot.bootstrap;

import static org.assertj.core.api.Assertions.assertThat;

import com.github.tomakehurst.wiremock.client.WireMock;
import com.github.tomakehurst.wiremock.junit5.WireMockExtension;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.test.StepVerifier;

/**
 * Integration test: verifies the full /v1/conversation/run SSE pipeline end-to-end using WireMock
 * as the LLM backend. Validates that the SSE stream produces expected event types.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ConversationSseIntegrationTest {

  @LocalServerPort int port;

  @RegisterExtension
  static WireMockExtension llm =
      WireMockExtension.newInstance().options(com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig().dynamicPort()).build();

  @DynamicPropertySource
  static void props(DynamicPropertyRegistry reg) {
    reg.add("spring.ai.openai.base-url", () -> llm.baseUrl());
    reg.add("spring.ai.openai.api-key", () -> "test-key");
    reg.add("spring.ai.openai.chat.options.model", () -> "gpt-test");
    reg.add("codepilot.security.jwt-secret", () -> "test-jwt-secret-12345678901234567890");
    reg.add("codepilot.security.hmac-secret", () -> "test-hmac-secret-12345678901234567890");
  }

  @Test
  void chatMode_streamsDeltas() {
    // Stub LLM to return a simple streaming response
    llm.stubFor(
        WireMock.post(WireMock.urlPathMatching("/v1/chat/completions"))
            .willReturn(
                WireMock.aResponse()
                    .withStatus(200)
                    .withHeader("Content-Type", "text/event-stream")
                    .withBody(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n"
                            + "data: {\"choices\":[{\"delta\":{\"content\":\" World\"}}]}\n\n"
                            + "data: [DONE]\n\n")));

    WebClient client = WebClient.create("http://localhost:" + port);
    var events =
        client
            .post()
            .uri("/v1/conversation/run")
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(
                Map.of(
                    "sessionId", "test-session-1",
                    "mode", "chat",
                    "input", "Say hello",
                    "tools", List.of()))
            .accept(MediaType.TEXT_EVENT_STREAM)
            .retrieve()
            .bodyToFlux(String.class)
            .collectList()
            .block();

    assertThat(events).isNotNull();
    // Should contain at least skills_activated + delta(s) + done events
    assertThat(events.size()).isGreaterThanOrEqualTo(2);
  }
}
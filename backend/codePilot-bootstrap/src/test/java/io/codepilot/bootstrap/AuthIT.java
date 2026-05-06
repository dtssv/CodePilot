package io.codepilot.bootstrap;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.test.web.reactive.server.WebTestClient;

/**
 * Integration test for the auth API using the Dev SSO verifier.
 * Proves: login → returns JWT + deviceSecret; refresh → returns fresh access token.
 */
class AuthIT extends IntegrationTestBase {

  @Autowired WebTestClient web;
  @Autowired ObjectMapper mapper;

  @Test
  void methods_returns_dev_enabled() {
    web.get()
        .uri("/v1/auth/methods")
        .accept(MediaType.APPLICATION_JSON)
        .exchange()
        .expectStatus()
        .isOk()
        .expectBody(JsonNode.class)
        .value(
            body -> {
              assertThat(body.path("data").path("dev").asBoolean()).isTrue();
            });
  }

  @Test
  void login_with_dev_token_issues_jwt() {
    // DevSsoVerifier format: <dev-token>:<userId>:<tenantId>:<deviceId>
    String ssoToken = "test-dev-token-16ch:user1:tenant1:device1";
    web.post()
        .uri("/v1/auth/login")
        .contentType(MediaType.APPLICATION_JSON)
        .bodyValue("{\"ssoToken\":\"" + ssoToken + "\"}")
        .exchange()
        .expectStatus()
        .isOk()
        .expectBody(JsonNode.class)
        .value(
            body -> {
              JsonNode data = body.path("data");
              assertThat(data.path("accessToken").asText()).isNotBlank();
              assertThat(data.path("refreshToken").asText()).isNotBlank();
              assertThat(data.path("deviceSecret").asText()).isNotBlank();
            });
  }

  @Test
  void refresh_with_valid_token_issues_new_access() {
    // First login to get a refresh token.
    String ssoToken = "test-dev-token-16ch:user2:tenant1:device2";
    JsonNode loginResp =
        web.post()
            .uri("/v1/auth/login")
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue("{\"ssoToken\":\"" + ssoToken + "\"}")
            .exchange()
            .expectStatus()
            .isOk()
            .expectBody(JsonNode.class)
            .returnResult()
            .getResponseBody();
    String refresh = loginResp.path("data").path("refreshToken").asText();
    web.post()
        .uri("/v1/auth/refresh")
        .contentType(MediaType.APPLICATION_JSON)
        .bodyValue("{\"refreshToken\":\"" + refresh + "\"}")
        .exchange()
        .expectStatus()
        .isOk()
        .expectBody(JsonNode.class)
        .value(body -> assertThat(body.path("data").path("accessToken").asText()).isNotBlank());
  }
}
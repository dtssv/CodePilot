package io.codepilot.core.safety;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/** Unit tests for {@link RedactionService}. */
class RedactionServiceTest {

  private final RedactionService service = new RedactionService();

  @Test
  void redacts_apiKeysWithPrefix() {
    String input =
        "Use this API key: sk-abc123456789012345678901234567890123456789 in your request.";
    String redacted = service.redact(input);
    assertThat(redacted).doesNotContain("sk-abc123456789012345678901234567890123456789");
    assertThat(redacted).contains("[REDACTED_API_KEY]");
  }

  @Test
  void redacts_jwtTokens() {
    String jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    String input = "Authorization: Bearer " + jwt;
    String redacted = service.redact(input);
    assertThat(redacted).doesNotContain(jwt);
    assertThat(redacted).contains("[REDACTED_API_KEY]");
  }

  @Test
  void preserves_normalText() {
    String input = "This is a normal conversation about coding patterns.";
    String redacted = service.redact(input);
    assertThat(redacted).isEqualTo(input);
  }

  @Test
  void redacts_privateKeyBlocks() {
    String input = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----";
    String redacted = service.redact(input);
    assertThat(redacted).doesNotContain("BEGIN RSA PRIVATE KEY");
    assertThat(redacted).contains("[REDACTED_PRIVATE_KEY]");
  }
}

package io.codepilot.core.ai;

import io.codepilot.core.safety.RedactionService;
import io.codepilot.core.safety.SystemPromptLeakDetector;
import java.util.Map;
import org.springframework.ai.chat.client.AdvisedRequest;
import org.springframework.ai.chat.client.ChatClientRequestSpec;
import org.springframework.ai.chat.client.ChatClientResponseSpec;
import org.springframework.ai.chat.model.ChatResponse;

/**
 * Advisor that applies safety guardrails around model calls:
 *
 * <ul>
 *   <li><b>Pre-call</b>: redact PII/credentials in the user message via {@link RedactionService};
 *       detect system-prompt leak attempts via {@link SystemPromptLeakDetector}.
 *   <li><b>Post-call</b>: (future) scan response for leaked system prompt fragments.
 * </ul>
 *
 * <p>This is intentionally lightweight for M3 — full post-call leak filtering will be added as a
 * separate WebFlux filter on the SSE stream.
 */
public class SafeguardAdvisor
    implements org.springframework.ai.chat.client.RequestResponseAdvisor {

  private final RedactionService redactionService;
  private final SystemPromptLeakDetector leakDetector;

  public SafeguardAdvisor(RedactionService redactionService) {
    this.redactionService = redactionService;
    this.leakDetector = new SystemPromptLeakDetector();
  }

  @Override
  public AdvisedRequest adviseRequest(AdvisedRequest request, Map<String, Object> context) {
    // Pre-call: redact PII in user text
    String userText = request.userText();
    if (userText != null && !userText.isBlank()) {
      // Check for system prompt leak attempts
      var verdict = leakDetector.detect(userText);
      if (verdict.blocked()) {
        // Replace the user message with a safe refusal prompt
        return AdvisedRequest.from(request)
            .withUserText(
                "[BLOCKED] The user input was blocked by safety policy. Reply briefly: "
                    + "\"I can help you with your coding tasks. What would you like to work on?\"")
            .build();
      }
      // Redact PII
      String redacted = redactionService.redact(userText);
      if (!redacted.equals(userText)) {
        return AdvisedRequest.from(request).withUserText(redacted).build();
      }
    }
    return request;
  }

  @Override
  public ChatResponse adviseResponse(ChatResponse response, Map<String, Object> context) {
    // Post-call: future — scan for system prompt leaks in model output.
    // For M3, we rely on the SystemPromptLeakFilter in the SSE stream.
    return response;
  }
}
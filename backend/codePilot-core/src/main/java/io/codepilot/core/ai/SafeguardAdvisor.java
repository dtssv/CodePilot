package io.codepilot.core.ai;

import io.codepilot.core.safety.RedactionService;
import io.codepilot.core.safety.SystemPromptLeakDetector;
import java.util.List;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.stereotype.Component;

/**
 * Pre/post safety guardrail around model calls.
 *
 * <p>For M3, this is implemented as a simple wrapper that modifies the prompt before sending and
 * checks the response after. It is NOT wired as a Spring AI Advisor (the Advisor API changed
 * between M2 and GA); instead, the AgentLoop calls it directly before invoking ChatClient.
 *
 * <ul>
 *   <li><b>Pre-call</b>: redact PII/credentials in user messages; detect system-prompt leak
 *       attempts.
 *   <li><b>Post-call</b>: (future) scan response for leaked system prompt fragments.
 * </ul>
 */
@Component
public class SafeguardAdvisor {

  private final RedactionService redactionService;
  private final SystemPromptLeakDetector leakDetector;

  public SafeguardAdvisor(RedactionService redactionService, SystemPromptLeakDetector leakDetector) {
    this.redactionService = redactionService;
    this.leakDetector = leakDetector;
  }

  /**
   * Checks user input for system prompt leak attempts. Returns null if safe, or a refusal message
   * if blocked.
   */
  public String checkLeakAttempt(String userInput) {
    if (userInput == null || userInput.isBlank()) {
      return null;
    }
    var verdict = leakDetector.detect(userInput);
    if (verdict.blocked()) {
      return "I can help you with your coding tasks. What would you like to work on?";
    }
    return null;
  }

  /**
   * Applies PII redaction to the user text. Returns the redacted version (may be the same as
   * input if no PII was found).
   */
  public String redact(String text) {
    if (text == null || text.isBlank()) {
      return text;
    }
    return redactionService.redact(text);
  }

  /**
   * Processes a Prompt before sending to the model: redacts PII in user messages and checks for
   * leak attempts.
   *
   * @return the sanitized prompt, or null if the input should be blocked entirely
   */
  public Prompt sanitize(Prompt prompt) {
    List<Message> messages = prompt.getInstructions();
    var sanitized = new java.util.ArrayList<Message>();

    for (Message msg : messages) {
      if (msg instanceof UserMessage userMsg) {
        String text = userMsg.getText();

        // Check for leak attempt
        var verdict = leakDetector.detect(text);
        if (verdict.blocked()) {
          // Replace with safe refusal
          sanitized.add(new UserMessage(
              "I can help you with your coding tasks. What would you like to work on?"));
          continue;
        }

        // Redact PII
        String redacted = redactionService.redact(text);
        sanitized.add(new UserMessage(redacted));
      } else {
        sanitized.add(msg);
      }
    }

    return new Prompt(sanitized);
  }
}
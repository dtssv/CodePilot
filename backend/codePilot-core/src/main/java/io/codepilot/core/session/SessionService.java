package io.codepilot.core.session;

import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Service;

/**
 * Utility service for session-level operations that don't run within the Agent loop. Provides
 * standalone LLM calls for title generation and conversation digest.
 */
@Service
public class SessionService {

  private static final Logger log = LoggerFactory.getLogger(SessionService.class);

  private static final String TITLE_PROMPT =
      """
      You are a helpful assistant. Based on the user's first message below, generate a short
      (max 8 words) descriptive title for this conversation. Reply with ONLY the title text,
      nothing else.

      First message: %s""";

  private static final String DIGEST_PROMPT =
      """
      Summarise the following conversation history in 2-3 concise sentences, focusing on the
      key topics discussed and any decisions made. Reply with ONLY the summary.

      History:
      %s""";

  private final ChatClient chatClient;

  public SessionService(ChatClient.Builder chatClientBuilder) {
    this.chatClient = chatClientBuilder.build();
  }

  /** Generate a short title for the given session based on the first user message. */
  public String generateTitle(UUID sessionId, String firstMessage) {
    String prompt = String.format(TITLE_PROMPT, firstMessage.substring(0, Math.min(500, firstMessage.length())));
    String title =
        chatClient.prompt().user(prompt).call().chatResponse().getResult().getOutput().getText();
    log.debug("Generated title for session {}: {}", sessionId, title);
    return title == null ? "New conversation" : title.trim();
  }

  /** Generate a standalone digest of the conversation history. */
  public String generateDigest(UUID sessionId, String history) {
    String prompt = String.format(DIGEST_PROMPT, history.substring(0, Math.min(4000, history.length())));
    String digest =
        chatClient.prompt().user(prompt).call().chatResponse().getResult().getOutput().getText();
    log.debug("Generated digest for session {}", sessionId);
    return digest == null ? "" : digest.trim();
  }
}
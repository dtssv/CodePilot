package io.codepilot.core.session.checkpoint;

import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.model.ModelSource;
import io.codepilot.core.session.Message;
import io.codepilot.core.session.SessionState;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.stereotype.Component;

/**
 * Checkpoint writer — generates a structured checkpoint summary at 20%, 45%, and 70% context
 * utilization thresholds.
 *
 * <p>Checkpoint-writer sub-agent which independently reads the conversation
 * and produces a structured summary that can be used to rebuild context if the conversation
 * overflows.
 *
 * <p>The checkpoint contains:
 *
 * <ul>
 *   <li>Task description and current status
 *   <li>Files read and modified
 *   <li>Key decisions made
 *   <li>Remaining work
 *   <li>Any errors encountered
 * </ul>
 */
@Component
public class CheckpointWriter {
  private static final Logger log = LoggerFactory.getLogger(CheckpointWriter.class);

  private static final String CHECKPOINT_PROMPT =
      """
      You are a checkpoint writer. Your job is to produce a structured summary
      of the conversation so far. This summary will be used to rebuild context
      if the conversation becomes too long.

      Output the checkpoint in the following format:

      # Checkpoint

      ## Task
      [One-line description of the original task]

      ## Status
      [Current status: in-progress / blocked / complete]

      ## Files Read
      [List of files that have been read]

      ## Files Modified
      [List of files that have been written or modified]

      ## Key Decisions
      [Important decisions made during the conversation]

      ## Errors Encountered
      [Any errors that occurred and how they were resolved]

      ## Remaining Work
      [What still needs to be done]

      ## Latest Context
      [Most recent 2-3 actions and their results]

      Be concise but complete. Focus on information needed to continue the task.
      """;

  private final ChatClientFactory chatClientFactory;

  public CheckpointWriter(ChatClientFactory chatClientFactory) {
    this.chatClientFactory = chatClientFactory;
  }

  /**
   * Generate a checkpoint for the current session state.
   *
   * @param session the current session state
   * @param contextUtilization current context utilization ratio (0.0 - 1.0)
   * @return the checkpoint text, or null if generation fails
   */
  public CheckpointResult writeCheckpoint(SessionState session, double contextUtilization) {
    String sessionId = session.getSessionId();
    log.info(
        "Writing checkpoint for session {} at {}% context utilization",
        sessionId, Math.round(contextUtilization * 100));

    try {
      var resolved =
          chatClientFactory.resolve(
              session.getModelId(),
              session.getModelSource() != null
                  ? ModelSource.valueOf(session.getModelSource())
                  : ModelSource.GROUP,
              session.getUserId());

      var systemMsg = new SystemMessage(CHECKPOINT_PROMPT);
      var userMsg = new UserMessage(buildConversationSnapshot(session));

      var opts = OpenAiChatOptions.builder().temperature(0.0).maxTokens(2048).build();

      var chatResponse = resolved.chatModel().call(new Prompt(List.of(systemMsg, userMsg), opts));
      String checkpoint = chatResponse.getResult().getOutput().getText();

      String token = "ckpt_" + UUID.randomUUID().toString().substring(0, 8);
      session.setCheckpointToken(token);
      session.setLastCheckpointAt(Instant.now());

      log.info("Checkpoint {} written for session {}", token, sessionId);
      return new CheckpointResult(token, checkpoint, contextUtilization);

    } catch (Exception e) {
      log.error("Failed to write checkpoint for session {}", sessionId, e);
      return null;
    }
  }

  private String buildConversationSnapshot(SessionState session) {
    var sb = new StringBuilder();
    sb.append("Session ID: ").append(session.getSessionId()).append("\n");
    sb.append("Turn count: ").append(session.getTurnCount()).append("\n");
    sb.append("Files read: ").append(session.getFilesRead()).append("\n");
    sb.append("Files written: ").append(session.getFilesWritten()).append("\n\n");

    sb.append("## Conversation History\n\n");
    List<Message> messages = session.getMessages();
    int start = Math.max(0, messages.size() - 20); // Last 20 messages
    for (int i = start; i < messages.size(); i++) {
      Message msg = messages.get(i);
      if (msg.role() == Message.Role.SYSTEM) continue; // Skip system prompts
      String excerpt =
          msg.content() != null
              ? msg.content().substring(0, Math.min(500, msg.content().length()))
              : "(tool call)";
      sb.append("[").append(msg.role()).append("]: ").append(excerpt).append("\n\n");
    }
    return sb.toString();
  }

  public record CheckpointResult(String token, String content, double contextUtilization) {}
}

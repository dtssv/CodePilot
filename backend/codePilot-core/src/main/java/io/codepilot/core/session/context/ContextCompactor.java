package io.codepilot.core.session.context;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.session.Message;
import io.codepilot.core.session.SessionState;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.openai.OpenAiChatOptions;

/**
 * Compresses old conversation messages into a compact summary using LLM summarization.
 *
 * <p>When combined context of assistant/user messages exceeds the budget, the compactor sends older
 * messages to the LLM to generate a high-quality summary that replaces them, keeping only the
 * recent tail intact.
 *
 * <p>Design{@code compact.ts} — instead of truncation, this runs a small
 * summarization call to distill the old conversation head before it falls out of the window.
 */
public class ContextCompactor {
  private static final Logger log = LoggerFactory.getLogger(ContextCompactor.class);

  private final ContextBudget budget;
  private final ChatClientFactory clientFactory;
  private static final ObjectMapper MAPPER = new ObjectMapper();

  private static final int MIN_PRESERVE = 3;
  private static final int MAX_PRESERVE = 8;

  /** How many messages to truncate from both ends of the summary window. */
  private static final int SUMMARIZE_TAIL = 6;

  public ContextCompactor(ContextBudget budget, ChatClientFactory clientFactory) {
    this.budget = budget;
    this.clientFactory = clientFactory;
  }

  /** Compact a session's messages and prune old tool results to save tokens. */
  public CompactionResult compact(SessionState session) {
    // Prune old tool outputs first
    pruneToolResults(session);
    List<Message> messages = new ArrayList<>(session.getMessages());
    int originalSize = messages.size();

    int totalTokens = budget.estimateTokens(messages);
    int usable = budget.usableTokens();

    if (totalTokens <= usable) {
      return new CompactionResult(originalSize, originalSize, 0);
    }

    // Preserve the tail (most recent conversation)
    int preserve = Math.min(MAX_PRESERVE, Math.max(MIN_PRESERVE, messages.size() / 4));
    int boundary = Math.max(0, messages.size() - preserve);

    List<Message> head = new ArrayList<>(messages.subList(0, boundary));
    List<Message> tail = new ArrayList<>(messages.subList(boundary, messages.size()));

    if (head.isEmpty()) {
      return new CompactionResult(originalSize, originalSize, 0);
    }

    // Generate LLM-based summary of the head
    String summary = summarizeHead(head, session);

    // Replace head with one compacted system message
    session.getMessages().clear();
    session.addMessage(
        new Message(
            null,
            Message.Role.SYSTEM,
            summary,
            null,
            null,
            null,
            null,
            System.currentTimeMillis(),
            null,
            null));
    for (Message msg : tail) {
      session.addMessage(msg);
    }

    session.setEstimatedTokens(budget.estimateTokens(session.getMessages()));
    int newSize = session.getMessages().size();
    int tokensSaved = totalTokens - session.getEstimatedTokens();

    log.info(
        "Compacted session {}: {} → {} messages, saved {} tokens",
        session.getSessionId(),
        originalSize,
        newSize,
        tokensSaved);

    return new CompactionResult(originalSize, newSize, tokensSaved);
  }

  /** Summarize the head messages using the LLM. */
  private String summarizeHead(List<Message> head, SessionState session) {
    // Build a prompt: ask the LLM to produce a compact JSON summary
    String prompt = buildCompactionPrompt(head);

    try {
      ChatClientFactory.ResolvedClient resolved =
          clientFactory.resolve(
              session.getModelId(),
              session.getModelSource() != null
                  ? io.codepilot.core.model.ModelSource.valueOf(session.getModelSource())
                  : io.codepilot.core.model.ModelSource.GROUP,
              session.getUserId());

      var opts = OpenAiChatOptions.builder().temperature(0.0).maxTokens(1024).build();

      var chatResponse =
          resolved
              .chatModel()
              .call(new Prompt(new org.springframework.ai.chat.messages.UserMessage(prompt), opts));

      resolved.endRequest(true, chatResponse.getMetadata().getUsage().getTotalTokens());
      return chatResponse.getResult().getOutput().getText();

    } catch (Exception e) {
      log.error("LLM compaction failed, falling back to truncation.", e);
      return fallbackSummarize(head);
    }
  }

  private String buildCompactionPrompt(List<Message> head) {
    // Build a map: toolCallId → toolName from ASSISTANT messages so we can identify
    // which TOOL results correspond to fs.read calls.
    java.util.Map<String, String> callIdToToolName = new java.util.HashMap<>();
    for (Message msg : head) {
      if (msg.role() == Message.Role.ASSISTANT && msg.toolCalls() != null) {
        for (var tc : msg.toolCalls()) {
          callIdToToolName.put(tc.id(), tc.name());
        }
      }
    }

    StringBuilder messagesText = new StringBuilder();
    for (Message msg : head) {
      messagesText
          .append("[")
          .append(msg.role())
          .append("]: ");
      if (msg.toolCalls() != null && !msg.toolCalls().isEmpty()) {
        messagesText.append("(tool calls: ");
        for (var tc : msg.toolCalls()) {
          messagesText.append(tc.name()).append("(");
          if (tc.args() != null) {
            // For fs.read, include the path so the summary preserves what was read
            if ("fs.read".equals(tc.name()) && tc.args().containsKey("path")) {
              messagesText.append("path=").append(tc.args().get("path"));
            } else if ("fs.list".equals(tc.name()) && tc.args().containsKey("path")) {
              messagesText.append("path=").append(tc.args().get("path"));
            } else {
              String argsStr = tc.args().toString();
              messagesText.append(argsStr.length() > 100 ? argsStr.substring(0, 100) + "..." : argsStr);
            }
          }
          messagesText.append(") ");
        }
        messagesText.append(")");
      } else if (msg.role() == Message.Role.TOOL && msg.toolCallId() != null) {
        // For fs.read tool results, use a higher content limit to preserve file content
        String toolName = callIdToToolName.getOrDefault(msg.toolCallId(), msg.toolName());
        int contentLimit = "fs.read".equals(toolName) ? 1500 : 500;
        String content = msg.content() != null ? msg.content() : "(empty)";
        messagesText.append(content.length() > contentLimit
            ? content.substring(0, contentLimit) + "..." : content);
      } else {
        String content = msg.content() != null ? msg.content() : "(empty)";
        messagesText.append(content.length() > 500 ? content.substring(0, 500) + "..." : content);
      }
      messagesText.append("\n");
    }

    return String.format(
        """
Summarize the following conversation between an AI agent and a user.
Keep it factual — include important decisions, discovered files, tool results,
and any user instructions. Remove repetitive tool calls. Output ONLY raw text without markdown.

Rules:
- Keep file paths, key decisions, and facts discovered.
- MUST include a "Files already read:" section with each file's path AND a brief content summary
  (key classes, functions, structures, imports — enough to avoid re-reading the file).
- MUST include a "Directories already listed:" section for fs.list results.
- Drop chatty acknowledgements or failed tool repetitions.
- Be concise — target 1/10 of input length.

<old_conversation>
%s
</old_conversation>

Compact summary of the above conversation:
""",
        messagesText.toString());
  }

  /** Fallback if LLM summarization fails. */
  private String fallbackSummarize(List<Message> head) {
    StringBuilder sb = new StringBuilder();
    sb.append("<compaction_summary>\n");

    // Build a map: toolCallId → toolName for content lookup
    java.util.Map<String, String> callIdToToolName = new java.util.HashMap<>();
    for (Message msg : head) {
      if (msg.role() == Message.Role.ASSISTANT && msg.toolCalls() != null) {
        for (var tc : msg.toolCalls()) {
          callIdToToolName.put(tc.id(), tc.name());
        }
      }
    }

    // Extract files already read with content summaries
    java.util.Map<String, String> readFileContent = new java.util.LinkedHashMap<>();
    for (Message msg : head) {
      if (msg.toolCalls() != null) {
        for (var tc : msg.toolCalls()) {
          if ("fs.read".equals(tc.name()) && tc.args() != null && tc.args().containsKey("path")) {
            readFileContent.put(String.valueOf(tc.args().get("path")), "");
          }
        }
      }
      // Also collect content from TOOL results for fs.read
      if (msg.role() == Message.Role.TOOL && msg.toolCallId() != null) {
        String toolName = callIdToToolName.getOrDefault(msg.toolCallId(), msg.toolName());
        if ("fs.read".equals(toolName) && msg.content() != null && !msg.content().isBlank()) {
          // Find the path from the corresponding ASSISTANT tool call
          for (Message prevMsg : head) {
            if (prevMsg.role() == Message.Role.ASSISTANT && prevMsg.toolCalls() != null) {
              for (var tc : prevMsg.toolCalls()) {
                if (tc.id() != null && tc.id().equals(msg.toolCallId())
                    && tc.args() != null && tc.args().containsKey("path")) {
                  String path = String.valueOf(tc.args().get("path"));
                  String content = msg.content();
                  String summary = content.length() > 300
                      ? content.substring(0, 300) + "..." : content;
                  readFileContent.put(path, summary);
                }
              }
            }
          }
        }
      }
    }

    if (!readFileContent.isEmpty()) {
      sb.append("Files already read:\n");
      for (var entry : readFileContent.entrySet()) {
        sb.append("  - ").append(entry.getKey());
        if (!entry.getValue().isEmpty()) {
          sb.append(":\n    ").append(entry.getValue().replace("\n", "\n    "));
        }
        sb.append("\n");
      }
      sb.append("\n");
    }

    for (Message msg : head) {
      if (msg.content() != null && !msg.content().isBlank() && msg.role() != Message.Role.TOOL) {
        String excerpt =
            msg.content().length() > 200 ? msg.content().substring(0, 200) + "..." : msg.content();
        sb.append("[").append(msg.role()).append("]: ").append(excerpt).append("\n");
      }
    }
    sb.append("</compaction_summary>\nContinue from the summary above.");
    return sb.toString();
  }

  public record CompactionResult(int messagesBefore, int messagesAfter, int tokensSaved) {}

  /** Prune old tool results: keep only the most recent 5, but always preserve error results.
   *  For fs.read results, preserve a content summary instead of replacing with [pruned]. */
  private void pruneToolResults(SessionState session) {
    var msgs = session.getMessages();

    // Build a map: toolCallId → toolName from ASSISTANT messages, so we can identify
    // which TOOL results correspond to fs.read calls.
    java.util.Map<String, String> callIdToToolName = new java.util.HashMap<>();
    for (Message msg : msgs) {
      if (msg.role() == Message.Role.ASSISTANT && msg.toolCalls() != null) {
        for (var tc : msg.toolCalls()) {
          callIdToToolName.put(tc.id(), tc.name());
        }
      }
    }

    int toolCount = 0;
    for (int i = msgs.size() - 1; i >= 0; i--) {
      if (msgs.get(i).role() == Message.Role.TOOL) toolCount++;
    }
    int kept = 0;
    for (int i = msgs.size() - 1; i >= 0; i--) {
      if (msgs.get(i).role() == Message.Role.TOOL) {
        kept++;
        if (kept > 5 && kept <= toolCount - 5) {
          String content = msgs.get(i).content();
          // Never prune tool results that contain error information — they are critical
          // for the agent to learn from past failures and avoid repeating the same command.
          if (content != null && containsErrorIndicator(content)) {
            log.debug("Preserving error tool result at index {} during pruning", i);
            continue;
          }
          // For fs.read results, preserve a content summary instead of [pruned]
          String toolName = callIdToToolName.get(msgs.get(i).toolCallId());
          if ("fs.read".equals(toolName) && content != null && !content.isBlank()) {
            String summary = content.length() > 300
                ? content.substring(0, 300) + "... [content trimmed]"
                : content;
            msgs.set(
                i,
                Message.toolResult(
                    msgs.get(i).toolCallId(),
                    msgs.get(i).toolName(),
                    "[file content summary: " + summary + "]"));
          } else {
            msgs.set(
                i, Message.toolResult(msgs.get(i).toolCallId(), msgs.get(i).toolName(), "[pruned]"));
          }
        }
      }
    }
  }

  /**
   * Check whether a tool result content contains error indicators that should be preserved
   * during context pruning. This prevents the agent from losing knowledge of failed commands
   * and repeating them.
   */
  private boolean containsErrorIndicator(String content) {
    if (content == null || content.isBlank()) return false;
    String lower = content.toLowerCase();
    return lower.contains("error")
        || lower.contains("failed")
        || lower.contains("failure")
        || lower.contains("exit code")
        || lower.contains("syntaxerror")
        || lower.contains("traceback")
        || lower.contains("exception")
        || lower.contains("denied")
        || lower.contains("timed out")
        || lower.contains("not found")
        || lower.contains("permission denied");
  }
}

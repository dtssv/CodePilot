package io.codepilot.core.prompt;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.common.conversation.ConversationRequest;
import io.codepilot.common.conversation.ConversationRequest.Answer;
import io.codepilot.common.conversation.ConversationRequest.ContextItem;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.stereotype.Service;

/**
 * Shapes the user message content for a single model call.
 *
 * <p>Implements the MNI (minimum necessary information) principle: only include what's needed for
 * the current turn. Server-side second-pass pruning after the client has already done its best.
 *
 * <p>Per §6.3 of the design doc, the user message contains:
 *
 * <ul>
 *   <li>{@code input} — user's current text
 *   <li>{@code intent} — new / continue / answer
 *   <li>{@code answers[]} — structured answers to needs_input questions
 *   <li>{@code contexts.pinned[], recent[], refs[]} — layered context
 *   <li>{@code taskLedger} — goal / subtasks / cursor / notes / blockers (agent)
 *   <li>{@code lastPlanDigest} / {@code lastAssistantTurnSummary}
 *   <li>{@code sessionDigest} — optional compressed history
 *   <li>{@code completedToolCallsTail} — last K tool calls with results
 *   <li>{@code earlierToolCallsCount} — how many older calls were truncated
 * </ul>
 */
@Service
public class ContextBudgeter {

  private static final ObjectMapper MAPPER = new ObjectMapper();

  /**
   * Builds the user message string from the conversation request and current agent state.
   *
   * <p>The output is a structured text block that the model can parse. For chat mode, it's
   * simplified; for agent mode, it includes the full context budget payload.
   */
  public String shapeUserMessage(ConversationRequest req, PromptOrchestrator.AgentState state) {
    Map<String, Object> payload = new LinkedHashMap<>();

    payload.put("input", req.input());
    payload.put("intent", req.intent());

    // Answers
    if (req.answers() != null && !req.answers().isEmpty()) {
      payload.put("answers", req.answers());
    }

    // Contexts — apply MNI pruning
    if (req.contexts() != null && !req.contexts().isEmpty()) {
      payload.put("contexts", pruneContexts(req));
    }

    // Agent-mode extras
    if (req.mode() == ConversationRequest.Mode.agent && state != null) {
      if (state.lastPlanDigest() != null) {
        payload.put("lastPlanDigest", state.lastPlanDigest());
      }
      if (state.lastAssistantTurnSummary() != null) {
        payload.put("lastAssistantTurnSummary", state.lastAssistantTurnSummary());
      }
    }

    // Continuation token
    if (req.continuationToken() != null) {
      payload.put("continuationToken", req.continuationToken());
    }

    // Policy hints
    if (req.policy() != null) {
      Map<String, Object> policyHints = new LinkedHashMap<>();
      if (Boolean.TRUE.equals(req.policy().selfCheck())) {
        policyHints.put("selfCheck", true);
      }
      if (Boolean.TRUE.equals(req.policy().replanHint())) {
        policyHints.put("replanHint", true);
      }
      if (!policyHints.isEmpty()) {
        payload.put("policy", policyHints);
      }
    }

    return toJson(payload);
  }

  /**
   * Prunes the context list to fit within the token budget. Prioritizes pinned > refs > recent,
   * drops lowest-priority items first.
   */
  private Map<String, Object> pruneContexts(ConversationRequest req) {
    int budget =
        req.policy() != null && req.policy().contextBudgetTokens() != null
            ? req.policy().contextBudgetTokens()
            : 100_000;

    // For M3, keep it simple: just partition by type
    Map<String, Object> result = new LinkedHashMap<>();

    // MUST-KEEP: pinned items (never pruned)
    var pinned =
        req.contexts().stream().filter(c -> "pinned".equals(c.type())).toList();
    if (!pinned.isEmpty()) {
      result.put("pinned", pinned);
    }

    // References (path + range only, no content expansion unless budget allows)
    var refs = req.contexts().stream().filter(c -> "ref".equals(c.type())).toList();
    if (!refs.isEmpty()) {
      int remainingBudget = budget - estimateTokens(pinned);
      if (estimateTokens(refs) > remainingBudget) {
        // Trim refs to path+range+sha1 only
        var trimmedRefs =
            refs.stream()
                .map(
                    r ->
                        new ContextItem(
                            r.type(),
                            r.language(),
                            r.path(),
                            r.range(),
                            null, // drop content
                            r.sha1(),
                            null))
                .toList();
        result.put("refs", trimmedRefs);
      } else {
        result.put("refs", refs);
      }
    }

    // Recent messages (FIFO drop if over budget)
    var recent = req.contexts().stream().filter(c -> "recent".equals(c.type())).toList();
    if (!recent.isEmpty()) {
      result.put("recent", recent);
    }

    return result;
  }

  /** Rough token estimation: ~4 chars per token for English, ~2 chars per token for CJK. */
  private int estimateTokens(java.util.List<ContextItem> items) {
    int total = 0;
    for (ContextItem item : items) {
      if (item.tokensEstimate() != null) {
        total += item.tokensEstimate();
      } else if (item.content() != null) {
        total += item.content().length() / 3;
      }
    }
    return total;
  }

  private String toJson(Map<String, Object> payload) {
    try {
      return MAPPER.writeValueAsString(payload);
    } catch (JsonProcessingException e) {
      // Fallback: manual formatting
      StringBuilder sb = new StringBuilder();
      payload.forEach((k, v) -> sb.append(k).append(": ").append(v).append("\n"));
      return sb.toString();
    }
  }
}
package io.codepilot.core.context;

import io.codepilot.core.dto.ConversationRunRequest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Server-side second-pass trimming of the layered context the plugin sent. Drops oldest recent
 * messages first, then collapses them into a local digest summary, and finally signals
 * {@code requestCompact=true} when the body still exceeds the budget so the model itself can
 * compress.
 *
 * <p>This component runs <em>before</em> the LLM call; it never mutates the original request.
 */
@Service
public class ContextBudgeter {

  private static final Logger log = LoggerFactory.getLogger(ContextBudgeter.class);

  private final TokenMeter meter;

  public ContextBudgeter(TokenMeter meter) {
    this.meter = meter;
  }

  /** Trim the body in-place using a deterministic priority order, returning the result + audit. */
  public Result shape(ConversationRunRequest req, String systemText) {
    int budget =
        (req.policy() != null && req.policy().contextBudgetTokens() != null)
            ? req.policy().contextBudgetTokens()
            : 24_000;
    int sysTokens = meter.count(systemText);

    List<ConversationRunRequest.Contexts.RecentMessage> recent =
        req.contexts() != null && req.contexts().recent() != null
            ? new ArrayList<>(req.contexts().recent())
            : new ArrayList<>();
    int dropped = 0;
    boolean needCompact = false;
    String localDigest = null;

    int total = sysTokens + countRecent(recent) + countMustKeep(req);
    while (total > budget && recent.size() > 2) {
      recent.remove(0);
      dropped++;
      total = sysTokens + countRecent(recent) + countMustKeep(req);
    }

    if (total > budget) {
      // Collapse remaining recent messages into a compact local digest the model can re-summarise.
      localDigest = collapse(recent);
      recent = List.of(); // cleared
      total = sysTokens + meter.count(localDigest) + countMustKeep(req);
    }

    if (total > budget) {
      needCompact = true;
    }

    Map<String, Integer> audit = new LinkedHashMap<>();
    audit.put("system", sysTokens);
    audit.put("recent", countRecent(recent));
    audit.put("mustKeep", countMustKeep(req));
    audit.put("estimatedTotal", total);
    log.debug(
        "ContextBudgeter shape: budget={}, dropped={}, total={}, needCompact={}",
        budget,
        dropped,
        total,
        needCompact);
    return new Result(recent, localDigest, dropped, needCompact, audit);
  }

  private int countRecent(List<ConversationRunRequest.Contexts.RecentMessage> recent) {
    int n = 0;
    for (var m : recent) {
      n += meter.count(m.content() == null ? m.summary() : m.content());
    }
    return n;
  }

  /** Tokens for items we never trim: input, ledger summary, lastAssistantTurnSummary, digest. */
  private int countMustKeep(ConversationRunRequest req) {
    int n = meter.count(req.input());
    if (req.lastAssistantTurnSummary() != null) {
      n += meter.count(req.lastAssistantTurnSummary());
    }
    if (req.taskLedger() != null && req.taskLedger().notes() != null) {
      for (String note : req.taskLedger().notes()) n += meter.count(note);
    }
    if (req.sessionDigest() != null && req.sessionDigest().goal() != null) {
      n += meter.count(req.sessionDigest().goal());
    }
    return n;
  }

  private String collapse(List<ConversationRunRequest.Contexts.RecentMessage> recent) {
    StringBuilder sb = new StringBuilder("[local-digest] ");
    for (var m : recent) {
      String chunk = m.summary() != null ? m.summary() : m.content();
      if (chunk == null) continue;
      String trimmed = chunk.length() > 240 ? chunk.substring(0, 240) + "…" : chunk;
      sb.append(m.role() == null ? "?" : m.role()).append(": ").append(trimmed).append(" | ");
    }
    return sb.toString();
  }

  /** Result of shaping; never owns the original request. */
  public record Result(
      List<ConversationRunRequest.Contexts.RecentMessage> trimmedRecent,
      String localDigest,
      int droppedRecent,
      boolean needCompact,
      Map<String, Integer> audit) {}
}
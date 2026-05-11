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
 * Server-side second-pass context trimming with full layered priority.
 *
 * <h3>Trimming priority (high → low):</h3>
 * <ol>
 *   <li><b>MUST-KEEP (never trim):</b> goal, cursor subtask branch, confirmed decisions,
 *       pinned items, completedToolCallsTail (last K=5)</li>
 *   <li><b>Degradable:</b> recent messages (FIFO drop), refs (keep path+range only, drop content)</li>
 *   <li><b>Collapsible:</b> multiple recent → local digest (non-model mathematical summary)</li>
 *   <li><b>Model compact:</b> if still over budget → set requestCompact=true for model to emit digest</li>
 * </ol>
 *
 * <p>This component runs <em>before</em> the LLM call; it produces a shaped Result that the
 * PromptOrchestrator uses for system/user message assembly.</p>
 */
@Service
public class ContextBudgeter {

  private static final Logger log = LoggerFactory.getLogger(ContextBudgeter.class);
  private static final int DEFAULT_BUDGET = 24_000;
  private static final int MIN_RECENT_KEEP = 2;
  private static final int TOOL_CALLS_TAIL_K = 5;
  private static final int REF_SUMMARY_MAX_CHARS = 120;

  private final TokenMeter meter;

  public ContextBudgeter(TokenMeter meter) {
    this.meter = meter;
  }

  /**
   * Shape the context to fit within the token budget.
   * Returns a Result with trimmed data and audit information.
   */
  public Result shape(ConversationRunRequest req, String systemText) {
    int budget = extractBudget(req);
    int sysTokens = meter.count(systemText);

    // Extract all layers
    var recent = extractRecent(req);
    var pinned = extractPinned(req);
    var refs = extractRefs(req);
    var toolCallsTail = extractToolCallsTail(req);
    int mustKeepTokens = countMustKeep(req, pinned, toolCallsTail);

    // Phase 1: Calculate total
    int total = sysTokens + mustKeepTokens + countRecent(recent) + countRefs(refs);
    int dropped = 0;
    boolean needCompact = false;
    String localDigest = null;
    boolean refsDowngraded = false;

    // Phase 2: Drop oldest recent messages (keep at least MIN_RECENT_KEEP)
    while (total > budget && recent.size() > MIN_RECENT_KEEP) {
      recent.remove(0);
      dropped++;
      total = sysTokens + mustKeepTokens + countRecent(recent) + countRefs(refs);
    }

    // Phase 3: Downgrade refs to path+range only (drop content/snippet)
    if (total > budget && !refs.isEmpty()) {
      refs = downgradeRefs(refs);
      refsDowngraded = true;
      total = sysTokens + mustKeepTokens + countRecent(recent) + countRefs(refs);
    }

    // Phase 4: Collapse remaining recent into a local digest
    if (total > budget && !recent.isEmpty()) {
      localDigest = collapse(recent);
      int digestTokens = meter.count(localDigest);
      recent = List.of();
      total = sysTokens + mustKeepTokens + digestTokens + countRefs(refs);
    }

    // Phase 5: Drop refs entirely if still over
    if (total > budget && !refs.isEmpty()) {
      refs = List.of();
      total = sysTokens + mustKeepTokens + (localDigest != null ? meter.count(localDigest) : 0);
    }

    // Phase 6: Signal model to compact
    if (total > budget) {
      needCompact = true;
    }

    // Build audit trail
    Map<String, Integer> audit = new LinkedHashMap<>();
    audit.put("budget", budget);
    audit.put("system", sysTokens);
    audit.put("mustKeep", mustKeepTokens);
    audit.put("recent", countRecent(recent));
    audit.put("refs", countRefs(refs));
    audit.put("localDigest", localDigest != null ? meter.count(localDigest) : 0);
    audit.put("estimatedTotal", total);
    audit.put("droppedRecent", dropped);

    log.debug("ContextBudgeter: budget={}, total={}, dropped={}, refsDowngraded={}, needCompact={}",
        budget, total, dropped, refsDowngraded, needCompact);

    return new Result(recent, refs, pinned, toolCallsTail, localDigest,
        dropped, refsDowngraded, needCompact, audit);
  }

  // ─── Extract helpers ──────────────────────────────────────────────

  private int extractBudget(ConversationRunRequest req) {
    if (req.policy() != null && req.policy().contextBudgetTokens() != null) {
      return req.policy().contextBudgetTokens();
    }
    return DEFAULT_BUDGET;
  }

  private List<ConversationRunRequest.Contexts.RecentMessage> extractRecent(ConversationRunRequest req) {
    if (req.contexts() != null && req.contexts().recent() != null) {
      return new ArrayList<>(req.contexts().recent());
    }
    return new ArrayList<>();
  }

  private List<ConversationRunRequest.Contexts.PinnedItem> extractPinned(ConversationRunRequest req) {
    if (req.contexts() != null && req.contexts().pinned() != null) {
      return new ArrayList<>(req.contexts().pinned());
    }
    return List.of();
  }

  private List<ConversationRunRequest.Contexts.Ref> extractRefs(ConversationRunRequest req) {
    if (req.contexts() != null && req.contexts().refs() != null) {
      return new ArrayList<>(req.contexts().refs());
    }
    return new ArrayList<>();
  }

  private List<ConversationRunRequest.CompletedToolCall> extractToolCallsTail(ConversationRunRequest req) {
    if (req.completedToolCallsTail() != null) {
      var all = req.completedToolCallsTail();
      if (all.size() > TOOL_CALLS_TAIL_K) {
        return new ArrayList<>(all.subList(all.size() - TOOL_CALLS_TAIL_K, all.size()));
      }
      return new ArrayList<>(all);
    }
    return List.of();
  }

  // ─── Count helpers ────────────────────────────────────────────────

  private int countRecent(List<ConversationRunRequest.Contexts.RecentMessage> recent) {
    int n = 0;
    for (var m : recent) {
      n += meter.count(m.content() == null ? m.summary() : m.content());
    }
    return n;
  }

  private int countRefs(List<ConversationRunRequest.Contexts.Ref> refs) {
    int n = 0;
    for (var r : refs) {
      n += meter.count(r.path());
      if (r.range() != null) n += meter.count(r.range());
    }
    return n;
  }

  /** Tokens for items we NEVER trim: input, ledger, plan digest, summaries, pinned, tool calls. */
  private int countMustKeep(ConversationRunRequest req,
                            List<ConversationRunRequest.Contexts.PinnedItem> pinned,
                            List<ConversationRunRequest.CompletedToolCall> toolCallsTail) {
    int n = meter.count(req.input());

    if (req.lastAssistantTurnSummary() != null) {
      n += meter.count(req.lastAssistantTurnSummary());
    }
    if (req.taskLedger() != null) {
      if (req.taskLedger().goal() != null) n += meter.count(req.taskLedger().goal());
      if (req.taskLedger().notes() != null) {
        for (String note : req.taskLedger().notes()) n += meter.count(note);
      }
    }
    if (req.sessionDigest() != null && req.sessionDigest().goal() != null) {
      n += meter.count(req.sessionDigest().goal());
    }
    if (req.lastPlanDigest() != null) {
      n += meter.count(req.lastPlanDigest().toString());
    }
    // Pinned items are MUST-KEEP
    for (var p : pinned) {
      n += meter.count(p.path());
    }
    // Tool call tail
    for (var tc : toolCallsTail) {
      n += meter.count(tc.summary() != null ? tc.summary() : tc.toolCallId());
    }
    // Project rules
    if (req.projectRules() != null) {
      for (var rule : req.projectRules()) {
        n += meter.count(rule);
      }
    }
    return n;
  }

  // ─── Transform helpers ────────────────────────────────────────────

  /** Downgrade refs to path+range only, setting outlineOnly=true. */
  private List<ConversationRunRequest.Contexts.Ref> downgradeRefs(
      List<ConversationRunRequest.Contexts.Ref> refs) {
    return refs.stream()
        .map(r -> new ConversationRunRequest.Contexts.Ref(r.path(), true, r.range(), r.sha1()))
        .toList();
  }

  /** Collapse recent messages into a compact non-model summary. */
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

  // ─── Result ───────────────────────────────────────────────────────

  /** Shaped context result. PromptOrchestrator uses this for message assembly. */
  public record Result(
      List<ConversationRunRequest.Contexts.RecentMessage> trimmedRecent,
      List<ConversationRunRequest.Contexts.Ref> trimmedRefs,
      List<ConversationRunRequest.Contexts.PinnedItem> pinned,
      List<ConversationRunRequest.CompletedToolCall> toolCallsTail,
      String localDigest,
      int droppedRecent,
      boolean refsDowngraded,
      boolean needCompact,
      Map<String, Integer> audit) {}
}
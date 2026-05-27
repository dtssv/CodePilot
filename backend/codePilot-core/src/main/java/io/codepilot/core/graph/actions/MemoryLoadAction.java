package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.context.ContextOrchestrator;
import io.codepilot.core.graph.GraphExecutionLog;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.memory.*;
import io.codepilot.core.sse.SseEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.stream.Collectors;

/**
 * MemoryLoad node: loads memories from all four layers, validates consistency,
 * and assembles the {@code activeMemories} list for downstream consumption.
 *
 * <p>This node sits between {@code intake} and {@code planning} in the graph,
 * ensuring that every subsequent node has access to relevant context from:
 * <ol>
 *   <li><b>Instantaneous</b> — conversation history from the current run (already in state)</li>
 *   <li><b>Short-term</b> — session digest and summary from previous turns</li>
 *   <li><b>Long-term</b> — project memories from Redis (ProjectMemoryStore)</li>
 *   <li><b>Global</b> — project rules from .codepilot/rules/ (already in state)</li>
 * </ol>
 *
 * <p>After loading, runs {@link MemoryConsistencyValidator} to detect anomalies
 * (conflicts, gaps, orphan references) and injects them into state as
 * {@code memoryAnomalies} so that generate/repair nodes can resolve them.
 *
 * <p>Finally, passes all loaded memories through {@link ContextOrchestrator#orchestrate}
 * for cold/hot dispatch and budget-aware trimming, producing the
 * {@code activeMemories} list that downstream nodes consume.
 */
@Component
public class MemoryLoadAction implements NodeAction {

    private static final Logger log = LoggerFactory.getLogger(MemoryLoadAction.class);

    /** Fallback default when no config is provided (backward compatibility). */
    private static final int FALLBACK_MEMORY_BUDGET = 6000;
    private static final int FALLBACK_MAX_PROJECT_MEMORIES = 20;

    private final ProjectMemoryStore projectMemoryStore;
    private final ContextOrchestrator contextOrchestrator;
    private final io.codepilot.core.run.GraphEngineProperties graphProperties;

    public MemoryLoadAction(ProjectMemoryStore projectMemoryStore,
                            ContextOrchestrator contextOrchestrator,
                            io.codepilot.core.run.GraphEngineProperties graphProperties) {
        this.projectMemoryStore = projectMemoryStore;
        this.contextOrchestrator = contextOrchestrator;
        this.graphProperties = graphProperties;
    }

    @Override
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "memoryLoad");
        GraphExecutionLog.nodeEnter(state, "memoryLoad");

        // ── Layer 1: Instantaneous memory (conversation history) ──
        List<StructuredMemory> instantMemories = loadInstantaneousMemory(state);
        List<StructuredMemory> allMemories = new ArrayList<>(instantMemories);
        updates.put("instantMemories", instantMemories.stream().map(StructuredMemory::toMap).toList());

        // ── Layer 2: Short-term memory (session digest) ──
        List<StructuredMemory> shortTermMemories = loadShortTermMemory(state);
        allMemories.addAll(shortTermMemories);
        updates.put("shortTermMemories", shortTermMemories.stream().map(StructuredMemory::toMap).toList());

        // ── Layer 3: Long-term project memory (tag-driven only; no input keyword inference) ──
        List<StructuredMemory> projectMemories = loadLongTermMemory(state);
        allMemories.addAll(projectMemories);
        updates.put("projectMemories", projectMemories.stream().map(StructuredMemory::toMap).toList());

        // ── Layer 4: Global memory (project rules — already in state, just wrap) ──
        List<StructuredMemory> globalMemories = loadGlobalMemory(state);
        allMemories.addAll(globalMemories);
        updates.put("globalMemories", globalMemories.stream().map(StructuredMemory::toMap).toList());

        // ── Consistency validation ──
        List<MemoryAnomaly> anomalies = MemoryConsistencyValidator.validate(allMemories);
        updates.put("memoryAnomalies", anomalies.stream().map(MemoryAnomaly::toPromptDirective).toList());

        if (!anomalies.isEmpty()) {
            log.info("MemoryLoadAction: {} anomalies detected, emitting memory.conflict event", anomalies.size());
            GraphSseHelper.emitEvent(state, SseEvents.MEMORY_CONFLICT,
                    Map.of("anomalies", anomalies.stream().map(MemoryAnomaly::toPromptDirective).toList()));
        }

        // ── Orchestrate: cold/hot dispatch + budget trimming ──
        int memoryBudget = resolveMemoryBudget(state);
        var orchestrationResult = contextOrchestrator.orchestrate(allMemories, memoryBudget);
        List<StructuredMemory> orchestratedMemories = orchestrationResult.memories();

        // ── Assemble activeMemories for downstream consumption ──
        updates.put("activeMemories", orchestratedMemories.stream().map(StructuredMemory::toMap).toList());
        updates.put("memoryBudget", memoryBudget);
        updates.put("memoryNeedsCompact", orchestrationResult.overBudget());

        if (orchestrationResult.overBudget()) {
            log.info("MemoryLoadAction: budget pressure detected ({} → {} memories, {} tokens / {} budget), LLM compaction hint enabled",
                    orchestrationResult.originalCount(), orchestrationResult.trimmedCount(),
                    orchestrationResult.tokensUsed(), orchestrationResult.tokensBudget());
        }

        log.info("MemoryLoadAction: loaded {} memories (instant={}, shortTerm={}, project={}, global={}), {} anomalies, orchestrated to {} within budget {}",
                allMemories.size(), instantMemories.size(), shortTermMemories.size(),
                projectMemories.size(), globalMemories.size(), anomalies.size(),
                orchestratedMemories.size(), memoryBudget);

        GraphExecutionLog.nodeExit(state, "memoryLoad", updates);
        return updates;
    }

    /**
     * Route after memoryLoad: always goes to planning (same conditions as intake→planning).
     * If intake already determined a shortcut path (conversationalOnly, CHAT mode),
     * memoryLoad still runs (to populate anomalies) but routes accordingly.
     */
    public String routeAfterMemoryLoad(OverAllState state) {
        // ★ Resume mode: if resuming from a checkpoint (resumeNextNode is set),
        // route directly to the target node instead of re-running planning.
        // Without this, resume always goes through planning, which discards the
        // previous plan and creates a new one from scratch — losing all context
        // about what was already done and what the user's answer referred to.
        String resumeNextNode = (String) state.value("resumeNextNode").orElse("");
        log.info("routeAfterMemoryLoad: resumeNextNode='{}', stateKeys={}", resumeNextNode, state.data().keySet());
        if (!resumeNextNode.isBlank()) {
            // Validate that the target node exists in the graph
            return switch (resumeNextNode) {
                case "planning", "preCheck", "generate", "applyPatch", "repair",
                     "gather", "askUser", "verify", "commit" -> resumeNextNode;
                default -> {
                    log.warn("routeAfterMemoryLoad: invalid resumeNextNode={}, falling back to planning", resumeNextNode);
                    yield "planning";
                }
            };
        }

        // Follow the same routing as intake — the memoryLoad node is transparent
        // to the routing logic; it just enriches state before planning.
        if (Boolean.TRUE.equals(state.value("conversationalOnly").orElse(false))) {
            return "intentDispatch";
        }
        String mode = (String) state.value("mode").orElse("AGENT");
        if ("CHAT".equalsIgnoreCase(mode)) {
            return "generate";
        }
        return "planning";
    }

    /**
     * Resolve the memory token budget: priority is state value → config property → fallback default.
     */
    private int resolveMemoryBudget(OverAllState state) {
        // 1. State-level override (e.g. set by intake from per-request config)
        Object budgetObj = state.value("memoryBudget").orElse(null);
        if (budgetObj instanceof Number num) {
            int budget = num.intValue();
            if (budget > 0) return budget;
        }
        // 2. Config-level default (GraphEngineProperties)
        int configured = graphProperties.getMemoryBudget();
        if (configured > 0) return configured;
        // 3. Hardcoded fallback
        return FALLBACK_MEMORY_BUDGET;
    }

    /** Resolve max project memories from config or fallback. */
    private int resolveMaxProjectMemories() {
        int configured = graphProperties.getMaxProjectMemories();
        return configured > 0 ? configured : FALLBACK_MAX_PROJECT_MEMORIES;
    }

    // ── Layer loaders ──

    /** Load instantaneous memory from conversation history. */
    @SuppressWarnings("unchecked")
    private List<StructuredMemory> loadInstantaneousMemory(OverAllState state) {
        List<Map<String, String>> history =
                (List<Map<String, String>>) state.value("conversationHistory").orElse(List.of());

        List<StructuredMemory> memories = new ArrayList<>();
        for (int i = 0; i < history.size(); i++) {
            Map<String, String> msg = history.get(i);
            String role = msg.getOrDefault("role", "");
            String content = msg.getOrDefault("content", "");
            if (content == null || content.isBlank()) continue;

            // Classify using unified rule-driven classifier
            ProtectionLevel protection = io.codepilot.core.graph.MemoryContentClassifier
                    .classifyProtectionLevel(content);
            MemoryType type = io.codepilot.core.graph.MemoryContentClassifier
                    .classifyMemoryType(content);

            String summary = content.length() > 120 ? content.substring(0, 120) + "..." : content;

            memories.add(StructuredMemory.of(
                    MemoryLayer.INSTANTANEOUS,
                    protection,
                    type,
                    summary,
                    content,
                    io.codepilot.core.graph.MemoryContentClassifier.extractTags(content),
                    ""
            ));
        }
        return memories;
    }

    /** Load short-term memory from session digest and summaryForNextTurn. */
    @SuppressWarnings("unchecked")
    private List<StructuredMemory> loadShortTermMemory(OverAllState state) {
        List<StructuredMemory> memories = new ArrayList<>();

        // sessionDigest
        Map<String, Object> digest =
                (Map<String, Object>) state.value("sessionDigest").orElse(Map.of());
        if (!digest.isEmpty()) {
            String goal = (String) digest.getOrDefault("goal", "");
            if (!goal.isBlank()) {
                memories.add(StructuredMemory.of(
                        MemoryLayer.SHORT_TERM,
                        ProtectionLevel.PROTECTED,
                        MemoryType.DECISION,
                        "Session goal: " + goal,
                        goal,
                        List.of("session", "goal"),
                        ""
                ));
            }
        }

        // summaryForNextTurn
        Map<String, Object> nextTurn =
                (Map<String, Object>) state.value("summaryForNextTurn").orElse(Map.of());
        if (!nextTurn.isEmpty()) {
            String summaryText = (String) nextTurn.getOrDefault("summaryText", "");
            if (!summaryText.isBlank()) {
                memories.add(StructuredMemory.of(
                        MemoryLayer.SHORT_TERM,
                        ProtectionLevel.PROTECTED,
                        MemoryType.FACT,
                        "Previous turn summary: " + abbreviate(summaryText, 120),
                        summaryText,
                        List.of("session", "summary"),
                        ""
                ));
            }
            List<String> changedFiles =
                    (List<String>) nextTurn.getOrDefault("changedFiles", List.of());
            if (!changedFiles.isEmpty()) {
                memories.add(StructuredMemory.of(
                        MemoryLayer.SHORT_TERM,
                        ProtectionLevel.PROTECTED,
                        MemoryType.FACT,
                        "Previously changed files: " + String.join(", ", changedFiles),
                        String.join("\n", changedFiles),
                        List.of("session", "files"),
                        ""
                ));
            }
        }

        return memories;
    }

    /**
     * Load long-term project memories only when planner/resume already provided phase tags.
     * Initial memoryLoad runs before planning — project memory is loaded after planning
     * via {@link io.codepilot.core.graph.PhaseAwareMemoryLoader}.
     */
    @SuppressWarnings("unchecked")
    private List<StructuredMemory> loadLongTermMemory(OverAllState state) {
        String projectRootHash = (String) state.value("projectRootHash").orElse("");
        if (projectRootHash.isBlank()) {
            return List.of();
        }

        List<String> queryTags = new ArrayList<>();
        List<Map<String, Object>> phases =
                (List<Map<String, Object>>) state.value("phases").orElse(List.of());
        String phaseCursor = (String) state.value("phaseCursor").orElse("");
        if (!phases.isEmpty()) {
            Map<String, Object> phase =
                    phaseCursor.isBlank()
                            ? phases.get(0)
                            : io.codepilot.core.graph.PhaseMemoryHelper.findPhase(phases, phaseCursor);
            queryTags = io.codepilot.core.graph.PhaseMemoryHelper.queryTagsFromPhase(phase);
        }

        if (queryTags.isEmpty()) {
            log.info("MemoryLoadAction: no phase tags yet — skipping long-term project memory preload");
            return List.of();
        }

        try {
            List<StructuredMemory> result =
                    projectMemoryStore
                            .loadByTags(projectRootHash, queryTags, resolveMaxProjectMemories())
                            .block();
            return result != null ? result : List.of();
        } catch (Exception e) {
            log.warn("Failed to load project memories from Redis (non-fatal): {}", e.getMessage());
            return List.of();
        }
    }

    /** Load global memory from project rules (already in state). */
    @SuppressWarnings("unchecked")
    private List<StructuredMemory> loadGlobalMemory(OverAllState state) {
        List<String> projectRules =
                (List<String>) state.value("projectRules").orElse(List.of());
        if (projectRules.isEmpty()) {
            return List.of();
        }

        List<StructuredMemory> memories = new ArrayList<>();
        for (String rule : projectRules) {
            if (rule == null || rule.isBlank()) continue;
            memories.add(StructuredMemory.of(
                    MemoryLayer.GLOBAL,
                    ProtectionLevel.IMMORTAL,
                    MemoryType.FACT,
                    abbreviate(rule, 120),
                    rule,
                    List.of("rule", "project"),
                    ""
            ));
        }
        return memories;
    }

    private String abbreviate(String s, int maxLen) {
        if (s == null) return "";
        return s.length() > maxLen ? s.substring(0, maxLen) + "..." : s;
    }
}
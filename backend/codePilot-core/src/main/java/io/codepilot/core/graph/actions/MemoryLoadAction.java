package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.context.ContextOrchestrator;
import io.codepilot.core.graph.*;
import io.codepilot.core.memory.*;
import io.codepilot.core.prompt.PromptRegistry;
import io.codepilot.core.sse.SseEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
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
    private static final int MAX_INSTANT_CLASSIFY_CACHE_SESSIONS = 512;

    private final ProjectMemoryStore projectMemoryStore;
    private final ContextOrchestrator contextOrchestrator;
    private final io.codepilot.core.run.GraphEngineProperties graphProperties;
    private final GraphAuxiliaryModelResolver auxiliaryModelResolver;
    private final PromptRegistry promptRegistry;
    private final ObjectMapper objectMapper;
    private final Map<String, InstantClassifyCacheEntry> instantClassifyCache = new ConcurrentHashMap<>();

    public MemoryLoadAction(ProjectMemoryStore projectMemoryStore,
                            ContextOrchestrator contextOrchestrator,
                            io.codepilot.core.run.GraphEngineProperties graphProperties,
                            GraphAuxiliaryModelResolver auxiliaryModelResolver,
                            PromptRegistry promptRegistry,
                            ObjectMapper objectMapper) {
        this.projectMemoryStore = projectMemoryStore;
        this.contextOrchestrator = contextOrchestrator;
        this.graphProperties = graphProperties;
        this.auxiliaryModelResolver = auxiliaryModelResolver;
        this.promptRegistry = promptRegistry;
        this.objectMapper = objectMapper;
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

    /** Load instantaneous memory from conversation history.
     *  <p>Strategy: LLM-first classification → role-based conservative fallback.
     *  The engineering layer does NOT guess memory type/protection from content length;
     *  it delegates that judgment to the model layer and falls back to safe defaults.
     */
    @SuppressWarnings("unchecked")
    private List<StructuredMemory> loadInstantaneousMemory(OverAllState state) {
        List<Map<String, String>> history =
                (List<Map<String, String>>) state.value("conversationHistory").orElse(List.of());

        if (history.isEmpty()) return List.of();

        // ── Try LLM-first batch classification ──
        List<InstantClassification> llmClassifications = null;
        try {
            llmClassifications = classifyInstantMemoriesWithLlmIncremental(state, history);
        } catch (Exception e) {
            log.warn("MemoryLoadAction: LLM instant classification failed, using role-based fallback: {}", e.getMessage());
        }

        List<StructuredMemory> memories = new ArrayList<>();
        for (int i = 0; i < history.size(); i++) {
            Map<String, String> msg = history.get(i);
            String role = msg.getOrDefault("role", "");
            String content = msg.getOrDefault("content", "");
            if (content == null || content.isBlank()) continue;

            ProtectionLevel protection;
            MemoryType type;
            List<String> tags;

            if (llmClassifications != null && i < llmClassifications.size()
                    && llmClassifications.get(i) != null) {
                // LLM provided classification — use it
                InstantClassification cls = llmClassifications.get(i);
                protection = cls.protection;
                type = cls.type;
                tags = cls.tags;
            } else {
                // Role-based conservative fallback — no heuristic guessing
                protection = MemoryContentClassifier.classifyProtectionLevel(content, role);
                type = MemoryContentClassifier.classifyMemoryType(content, role);
                tags = MemoryContentClassifier.extractTags(content, role);
            }

            String summary = content.length() > 120 ? content.substring(0, 120) + "..." : content;

            memories.add(StructuredMemory.of(
                    MemoryLayer.INSTANTANEOUS,
                    protection,
                    type,
                    summary,
                    content,
                    tags,
                    ""
            ));
        }
        return memories;
    }

    // ── LLM-based instant memory classification ──

    /** Classification result from LLM for a single message. */
    private record InstantClassification(
            ProtectionLevel protection, MemoryType type, List<String> tags) {}
    private record InstantClassifyCacheEntry(
            List<String> historySignatures,
            List<InstantClassification> classifications) {}

    private List<InstantClassification> classifyInstantMemoriesWithLlmIncremental(
            OverAllState state, List<Map<String, String>> history) throws Exception {
        String sessionId = String.valueOf(state.value("sessionId").orElse(""));
        if (sessionId.isBlank()) {
            return classifyInstantMemoriesWithLlm(state, history, 0);
        }

        List<String> signatures = historySignatures(history);
        InstantClassifyCacheEntry cached = instantClassifyCache.get(sessionId);
        if (cached == null) {
            List<InstantClassification> classified = classifyInstantMemoriesWithLlm(state, history, 0);
            if (classified != null) {
                putInstantClassifyCache(sessionId, signatures, classified);
            }
            return classified;
        }

        int commonPrefix = commonPrefixLength(cached.historySignatures(), signatures);
        boolean fullHit = commonPrefix == signatures.size()
                && cached.classifications().size() == history.size();
        if (fullHit) {
            log.debug("MemoryLoadAction: instant classification cache hit for session={}", sessionId);
            return cached.classifications();
        }

        List<InstantClassification> merged = new ArrayList<>(Collections.nCopies(history.size(), null));
        for (int i = 0; i < commonPrefix && i < cached.classifications().size(); i++) {
            merged.set(i, cached.classifications().get(i));
        }

        List<InstantClassification> delta = classifyInstantMemoriesWithLlm(state, history, commonPrefix);
        if (delta != null) {
            for (int i = commonPrefix; i < delta.size(); i++) {
                merged.set(i, delta.get(i));
            }
        }
        putInstantClassifyCache(sessionId, signatures, merged);
        log.info("MemoryLoadAction: instant classification incremental refresh for session={}, commonPrefix={}, total={}",
                sessionId, commonPrefix, signatures.size());
        return merged;
    }

    /**
     * Call LLM to batch-classify conversation messages.
     * Returns a list aligned with the input history (same index),
     * or null entries for messages the LLM did not classify.
     */
    private List<InstantClassification> classifyInstantMemoriesWithLlm(
            OverAllState state, List<Map<String, String>> history, int startIndex) throws Exception {

        String template = promptRegistry.get("graph.memoryClassify-instant");
        if (template == null || template.isBlank()) {
            log.debug("MemoryLoadAction: no prompt template 'graph.memoryClassify-instant', skipping LLM classification");
            return null;
        }
        if (startIndex >= history.size()) {
            return new ArrayList<>(Collections.nCopies(history.size(), null));
        }

        // Build messages payload for the prompt
        StringBuilder messagesText = new StringBuilder();
        for (int i = startIndex; i < history.size(); i++) {
            Map<String, String> msg = history.get(i);
            String role = msg.getOrDefault("role", "");
            String content = msg.getOrDefault("content", "");
            if (content == null || content.isBlank()) continue;
            // Truncate long content to keep prompt within budget
            if (content.length() > 300) {
                content = content.substring(0, 300) + "...";
            }
            messagesText.append("[").append(i).append("] <").append(role).append("> ")
                    .append(content.replace("\n", "\\n"))
                    .append("\n");
        }

        if (messagesText.isEmpty()) return null;

        String prompt = template.replace("{{messages}}", messagesText.toString());

        String response =
                auxiliaryModelResolver.completeUserPrompt(state, "memory-classify-instant", prompt);

        return parseInstantClassifications(response, history.size());
    }

    private List<InstantClassification> parseInstantClassifications(
            String response, int historySize) throws Exception {

        String json = LlmJsonExtract.parseableJson(response);
        JsonNode root = objectMapper.readTree(json);
        JsonNode arr = root.get("classifications");
        if (arr == null || !arr.isArray()) {
            log.warn("MemoryLoadAction: LLM classification response missing 'classifications' array");
            return null;
        }

        // Build indexed result list, initialize with nulls
        List<InstantClassification> result = new ArrayList<>(
                Collections.nCopies(historySize, null));

        for (JsonNode node : arr) {
            int index = node.path("index").asInt(-1);
            if (index < 0 || index >= historySize) continue;

            ProtectionLevel protection = parseEnum(
                    node.path("protection").asText("DEGRADABLE"),
                    ProtectionLevel.class, ProtectionLevel.DEGRADABLE);
            MemoryType type = parseEnum(
                    node.path("type").asText("FACT"),
                    MemoryType.class, MemoryType.FACT);
            List<String> tags = new ArrayList<>();
            JsonNode tagsNode = node.get("tags");
            if (tagsNode != null && tagsNode.isArray()) {
                for (JsonNode t : tagsNode) {
                    String tag = t.asText("").trim();
                    if (!tag.isBlank()) tags.add(tag);
                }
            }

            result.set(index, new InstantClassification(protection, type, tags));
        }
        return result;
    }

    private List<String> historySignatures(List<Map<String, String>> history) {
        List<String> signatures = new ArrayList<>(history.size());
        for (Map<String, String> message : history) {
            String role = message.getOrDefault("role", "");
            String content = message.getOrDefault("content", "");
            signatures.add(Integer.toHexString(Objects.hash(role, content)));
        }
        return signatures;
    }

    private int commonPrefixLength(List<String> a, List<String> b) {
        int limit = Math.min(a.size(), b.size());
        int i = 0;
        while (i < limit && Objects.equals(a.get(i), b.get(i))) {
            i++;
        }
        return i;
    }

    private void putInstantClassifyCache(
            String sessionId,
            List<String> signatures,
            List<InstantClassification> classifications) {
        if (instantClassifyCache.size() > MAX_INSTANT_CLASSIFY_CACHE_SESSIONS) {
            instantClassifyCache.clear();
        }
        instantClassifyCache.put(
                sessionId,
                new InstantClassifyCacheEntry(
                        List.copyOf(signatures),
                        List.copyOf(classifications)));
    }

    private static <E extends Enum<E>> E parseEnum(String raw, Class<E> enumType, E fallback) {
        if (raw == null || raw.isBlank()) return fallback;
        try {
            return Enum.valueOf(enumType, raw.trim().toUpperCase().replace('-', '_'));
        } catch (IllegalArgumentException e) {
            return fallback;
        }
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
                            ? phases.getFirst()
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
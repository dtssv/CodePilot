package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.graph.ContextShardResolver;
import io.codepilot.core.graph.GraphAuxiliaryModelResolver;
import io.codepilot.core.graph.GraphExecutionLog;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.graph.LlmJsonExtract;
import io.codepilot.core.graph.PhaseMemoryHelper;
import io.codepilot.core.prompt.PromptRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Dynamic plan expansion node: when a hierarchical plan is active and the
 * current macro-phase's micro-phases are all completed, this node calls the
 * LLM to expand the next macro-phase into executable micro-phases.
 *
 * <h3>Flow:</h3>
 * <pre>
 * commit → [all micro-phases done for current macro-phase?]
 *   → yes → DynamicPlanExpand → preCheck (with new micro-phases)
 *   → no  → preCheck (continue current micro-phases)
 * </pre>
 *
 * <h3>Why this matters for super-complex tasks:</h3>
 * Instead of asking the LLM to plan 400+ phases upfront (which it can't do
 * reliably), we ask it to plan 4 macro-phases, then expand each one
 * on-demand (25-100 micro-phases at a time), keeping the planning context
 * focused and manageable.
 */
@Component
public class DynamicPlanExpandAction implements NodeAction {

    private static final Logger log = LoggerFactory.getLogger(DynamicPlanExpandAction.class);

    private final GraphAuxiliaryModelResolver auxiliaryModelResolver;
    private final PromptRegistry promptRegistry;
    private final ObjectMapper mapper;
    private final io.codepilot.core.graph.ContextShardStore shardStore;
    private final io.codepilot.core.graph.PhaseAwareMemoryLoader phaseAwareMemoryLoader;

    public DynamicPlanExpandAction(GraphAuxiliaryModelResolver auxiliaryModelResolver,
                                   PromptRegistry promptRegistry,
                                   ObjectMapper mapper,
                                   io.codepilot.core.graph.ContextShardStore shardStore,
                                   io.codepilot.core.graph.PhaseAwareMemoryLoader phaseAwareMemoryLoader) {
        this.auxiliaryModelResolver = auxiliaryModelResolver;
        this.promptRegistry = promptRegistry;
        this.mapper = mapper;
        this.shardStore = shardStore;
        this.phaseAwareMemoryLoader = phaseAwareMemoryLoader;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "dynamicPlanExpand");
        GraphExecutionLog.nodeEnter(state, "dynamicPlanExpand");

        boolean hierarchicalPlan = Boolean.TRUE.equals(state.value("hierarchicalPlan").orElse(false));
        if (!hierarchicalPlan) {
            log.info("DynamicPlanExpandAction: no hierarchical plan, skipping");
            updates.put("expandResult", "skip");
            GraphExecutionLog.nodeExit(state, "dynamicPlanExpand", updates);
            return updates;
        }

        List<Map<String, Object>> macroPhases =
                (List<Map<String, Object>>) state.value("macroPhases").orElse(List.of());
        int macroPhaseCursor = (int) state.value("macroPhaseCursor").orElse(0);

        // Check if there's a next macro-phase to expand
        int nextMacroIdx = macroPhaseCursor + 1;
        if (nextMacroIdx >= macroPhases.size()) {
            log.info("DynamicPlanExpandAction: all {} macro-phases completed, no more to expand", macroPhases.size());
            updates.put("expandResult", "allDone");
            GraphExecutionLog.nodeExit(state, "dynamicPlanExpand", updates);
            return updates;
        }

        Map<String, Object> nextMacroPhase = macroPhases.get(nextMacroIdx);
        String macroTitle = (String) nextMacroPhase.getOrDefault("title", "Unknown");
        String macroIntent = (String) nextMacroPhase.getOrDefault("intent", "code-change");

        log.info("DynamicPlanExpandAction: expanding macro-phase {}/{}: {}",
                nextMacroIdx + 1, macroPhases.size(), macroTitle);

        // ── Build expansion prompt ──
        String input = (String) state.value("input").orElse("");
        @SuppressWarnings("unchecked")
        List<String> completedPhases =
                (List<String>) state.value("completedPhases").orElse(List.of());
        String projectMeta = (String) state.value("projectMeta").orElse("");

        String contextShardSection = loadContextShardsForExpand(state, nextMacroPhase);

        String expandPrompt = buildExpandPrompt(input, macroTitle, macroIntent,
                completedPhases, projectMeta, contextShardSection);

        String llmResponse;
        try {
            llmResponse =
                    auxiliaryModelResolver.streamUserPromptToSse(
                            state, "dynamic-plan-expand", expandPrompt, updates);
        } catch (Exception e) {
            log.error("DynamicPlanExpandAction: LLM call failed, creating fallback micro-phases", e);
            var fallbackPhases = createFallbackMicroPhases(nextMacroPhase, nextMacroIdx);
            applyExpandedPhases(state, updates, fallbackPhases, nextMacroIdx);
            loadMemoryForFirstMicroPhase(state, updates, fallbackPhases);
            updates.put("expandResult", "fallback");
            GraphExecutionLog.nodeExit(state, "dynamicPlanExpand", updates);
            return updates;
        }

        // ── Parse micro-phases from LLM response ──
        try {
            var microPhases = parseMicroPhasesResponse(llmResponse, nextMacroIdx);
            applyExpandedPhases(state, updates, microPhases, nextMacroIdx);
            loadMemoryForFirstMicroPhase(state, updates, microPhases);
            updates.put("expandResult", "expanded");
            log.info("DynamicPlanExpandAction: expanded macro-phase {} into {} micro-phases",
                    macroTitle, microPhases.size());
        } catch (Exception e) {
            log.warn("DynamicPlanExpandAction: failed to parse LLM response, using fallback", e);
            var fallbackPhases = createFallbackMicroPhases(nextMacroPhase, nextMacroIdx);
            applyExpandedPhases(state, updates, fallbackPhases, nextMacroIdx);
            loadMemoryForFirstMicroPhase(state, updates, fallbackPhases);
            updates.put("expandResult", "fallback");
        }

        GraphExecutionLog.nodeExit(state, "dynamicPlanExpand", updates);
        return updates;
    }

    /** Apply expanded micro-phases to state updates. */
    private void applyExpandedPhases(
            OverAllState state,
            Map<String, Object> updates,
            List<Map<String, Object>> microPhases,
            int nextMacroIdx) {
        // Mark all micro-phases as internal (user-invisible) — they belong to a macro-phase
        // that is the user-visible plan step. The UI only shows macro-phase progress.
        List<Map<String, Object>> markedPhases = new ArrayList<>();
        for (Map<String, Object> phase : microPhases) {
            Map<String, Object> marked = new LinkedHashMap<>(PhaseMemoryHelper.withDefaults(phase));
            marked.put("internalPhase", true);
            marked.put("macroPhaseIndex", nextMacroIdx);
            markedPhases.add(marked);
        }

        updates.put("phases", markedPhases);
        updates.put("phaseCursor", markedPhases.get(0).get("id"));
        updates.put("macroPhaseCursor", nextMacroIdx);
        updates.put("completedPhases", List.of());
        updates.put("phaseGeneratePasses", 0);
        updates.put("phaseFailureRetries", 0);
        updates.put("accumulatedPatches", List.of());

        // Emit graph_plan event with new micro-phases
        // Must pass non-null state so GraphSseHelper can locate sessionId.
        GraphSseHelper.emitEvent(state, io.codepilot.core.sse.SseEvents.GRAPH_PLAN,
                Map.of("phases", microPhases, "graphId", "gph-expand-" + nextMacroIdx));
    }

    /** Build the prompt for LLM to expand a macro-phase into micro-phases. */
    @SuppressWarnings("unchecked")
    private String buildExpandPrompt(String input, String macroTitle, String macroIntent,
                                      List<String> completedPhases, String projectMeta,
                                      String contextShardSection) {
        String template = promptRegistry.getOptional("graph.plan-expand");
        if (template == null || template.isBlank()) {
            // Fallback inline prompt if template not registered — generic, no domain assumptions
            template = """
            You are expanding a macro-phase into detailed micro-phases for task execution.
            
            Original task: {{input}}
            Current macro-phase: {{macroTitle}} (intent: {{macroIntent}})
            Previously completed phases: {{completedPhases}}
            {{projectMeta}}
            {{contextShards}}
            
            Return a JSON with a "phases" array. Each phase MUST include:
            - id: unique string (e.g., "m1_p1")
            - title: short description of what this micro-phase accomplishes
            - intent: one of [code-change, compile, run, analyze, synthesize]
            - tags: array of semantic tags for memory retrieval — YOU decide these based on the task domain
              (e.g., for a database task: ["user_table", "entity"]; for a frontend task: ["UserComponent", "react"])
            - memoryHints: (optional) array of strings describing what context this phase needs from memory
              (e.g., ["table definition for User", "existing UserEntity.java"])
            - requiredProducts: (optional) array of product categories that MUST exist from previous phases
              (e.g., ["entity"] means entity files must exist before this phase starts)
            - productPatterns: (optional) array of glob-style filename patterns to verify requiredProducts
              (e.g., ["*Entity.java", "*Model.java"] for entity verification)
            - productSearchPaths: (optional) array of directory paths to search for requiredProducts
              (e.g., ["src/main/java/com/example/entity/"])
            - requiredFiles: (optional) array of specific file paths this phase needs to exist
            - entry: [] (pre-conditions)
            - exit: [] (post-conditions)
            - budget: {"attempts": 3}
            
            CRITICAL SPLITTING RULES:
            1. Each micro-phase must produce a SMALL, manageable set of outputs — typically 3-10 files
               that can be generated in a SINGLE LLM call. If the macro-phase requires producing
               100+ files, you MUST split it into 10-30 micro-phases, each handling a subset.
            2. NEVER create a single micro-phase that tries to generate dozens of files — the LLM
               will fail to produce them all in one call, leading to incomplete output.
            3. Group related items together in the same micro-phase (e.g., all files for the same
               entity/table/module), but keep each group small enough for a single LLM call.
            4. Order micro-phases by dependency: if phase B depends on outputs of phase A,
               A must appear before B in the array.
            5. Each micro-phase's tags must be specific enough to retrieve only the context
               needed for that subset — not the entire input.
            
            IMPORTANT: You must determine ALL domain-specific metadata yourself — tags, memoryHints,
            requiredProducts, productPatterns, productSearchPaths. Do NOT leave these empty for phases
            that have domain dependencies. The execution engine relies on YOUR declarations, not inference.
            """;
        }

        return template
                .replace("{{input}}", input)
                .replace("{{macroTitle}}", macroTitle)
                .replace("{{macroIntent}}", macroIntent)
                .replace("{{completedPhases}}", String.join(", ", completedPhases))
                .replace("{{projectMeta}}", projectMeta.isBlank() ? "" :
                        "[PROJECT CONTEXT]\n" + projectMeta + "\n")
                .replace("{{contextShards}}", contextShardSection);
    }

    /** Parse micro-phases from LLM response. */
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> parseMicroPhasesResponse(String llmResponse, int macroIdx) throws Exception {
        String json = LlmJsonExtract.parseableJson(llmResponse);
        JsonNode root = mapper.readTree(json);
        JsonNode phasesNode = root.get("phases");
        if (phasesNode == null || !phasesNode.isArray() || phasesNode.isEmpty()) {
            throw new IllegalArgumentException("No phases array in LLM response");
        }
        List<Map<String, Object>> phases = mapper.convertValue(phasesNode, List.class);
        // Ensure IDs are unique by prefixing with macro index
        for (int i = 0; i < phases.size(); i++) {
            Map<String, Object> phase = new LinkedHashMap<>(phases.get(i));
            phase.putIfAbsent("id", "m" + macroIdx + "_p" + (i + 1));
            phase.putIfAbsent("intent", "code-change");
            phase.putIfAbsent("entry", List.of());
            phase.putIfAbsent("exit", List.of());
            phase.putIfAbsent("budget", Map.of("attempts", 3));
            phases.set(i, phase);
        }
        return phases;
    }

    /** Create fallback micro-phases when LLM expansion fails. */
    private List<Map<String, Object>> createFallbackMicroPhases(Map<String, Object> macroPhase, int macroIdx) {
        String title = (String) macroPhase.getOrDefault("title", "Implementation");
        return List.of(
                Map.of("id", "m" + macroIdx + "_p1",
                        "title", title,
                        "intent", macroPhase.getOrDefault("intent", "code-change"),
                        "entry", List.of(), "exit", List.of(),
                        "budget", Map.of("attempts", 3))
        );
    }

    /**
     * Load phase-aware memories for the first micro-phase of a newly expanded macro-phase.
     *
     * <p>When macro-phase transitions happen via dynamicPlanExpand, the normal
     * CommitAction→preCheck path (which calls PhaseAwareMemoryLoader) is bypassed.
     * This method ensures the first micro-phase gets its ProjectMemory + ContextShard
     * loaded into activeMemories before execution starts.
     *
     * <p>Since the new phases haven't been applied to state yet, we read tags directly
     * from the microPhases list and query ProjectMemoryStore + ContextShardStore manually.
     */
    @SuppressWarnings("unchecked")
    private void loadMemoryForFirstMicroPhase(OverAllState state,
                                               Map<String, Object> updates,
                                               List<Map<String, Object>> microPhases) {
        if (microPhases.isEmpty()) return;
        Map<String, Object> firstPhase = microPhases.get(0);
        String firstPhaseId = (String) firstPhase.getOrDefault("id", "");
        if (firstPhaseId.isBlank()) return;

        List<String> queryTags = PhaseMemoryHelper.queryTagsFromPhase(firstPhase);

        try {
            phaseAwareMemoryLoader.loadWithExplicitTags(state, updates, firstPhaseId, queryTags);
            log.info("DynamicPlanExpandAction: loaded phase-aware memories for first micro-phase {}",
                    firstPhaseId);
        } catch (Exception e) {
            log.warn("DynamicPlanExpandAction: failed to load memories for first micro-phase {} (non-fatal): {}",
                    firstPhaseId, e.getMessage());
        }
    }

    /**
     * Load context shards from ContextShardStore for the macro-phase being expanded.
     * Uses the macro-phase's tags for targeted retrieval; falls back to all shards.
     */
    private String loadContextShardsForExpand(OverAllState state, Map<String, Object> macroPhase) {
        String projectRootHash = (String) state.value("projectRootHash").orElse("");
        String contextSourceId = (String) state.value("contextSourceId").orElse("");
        List<String> queryTags = PhaseMemoryHelper.queryTagsFromPhase(macroPhase);
        PhaseMemoryHelper.LoadShardMode mode = PhaseMemoryHelper.LoadShardMode.fromPhase(macroPhase);
        int memoryBudget = state.value("memoryBudget")
                .map(v -> v instanceof Number n ? n.intValue() : 0)
                .orElse(0);
        int maxChars = memoryBudget > 0 ? Math.max(memoryBudget * 4, 16000) : 16000;
        var resolved =
                ContextShardResolver.resolveForPrompt(
                        shardStore, projectRootHash, contextSourceId, queryTags, mode, maxChars);
        log.info("DynamicPlanExpandAction: context shards for expand: {} shards, {} chars",
                resolved.shards().size(), resolved.charsUsed());
        return resolved.promptSection();
    }

    /**
     * Route after dynamicPlanExpand: always go to preCheck to start the new micro-phases.
     */
    public String routeAfterDynamicPlanExpand(OverAllState state) {
        String result = (String) state.value("expandResult").orElse("expanded");
        return switch (result) {
            case "allDone" -> "summarize";
            default -> "preCheck";
        };
    }
}
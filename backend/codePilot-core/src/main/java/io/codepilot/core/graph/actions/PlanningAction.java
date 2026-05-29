package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.graph.GraphAuxiliaryModelResolver;
import io.codepilot.core.graph.GraphExecutionLog;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.graph.GraphStreamProcessor;
import io.codepilot.core.graph.GraphUiEmitter;
import io.codepilot.core.graph.PhaseMemoryHelper;
import io.codepilot.core.graph.PhasePlanNormalizer;
import io.codepilot.core.graph.UserPlanProgressHelper;
import io.codepilot.core.graph.LlmJsonExtract;
import io.codepilot.core.graph.skill.GraphSkillNode;
import io.codepilot.core.graph.skill.GraphSkillSupport;
import io.codepilot.core.prompt.PromptRegistry;
import io.codepilot.core.sse.SseEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Planning node: calls the LLM to produce a two-layer plan.
 *
 * <h3>Layer 1 — User Plan (stable, user-facing)</h3>
 * High-level steps shown in the Plan panel. Emitted as {@code user_plan} SSE event.
 *
 * <h3>Layer 2 — Execution Phases (dynamic, graph-internal)</h3>
 * Detailed phases[] that drive the Graph engine's PhaseLoop.
 * Emitted as {@code graph_plan} SSE event.
 *
 * <p>The LLM is prompted to return a JSON with both {@code userPlan} and {@code phases[]}.
 * If LLM needs more info first, it returns {@code infoRequests[]} instead.
 */
@Component
public class PlanningAction implements NodeAction {

    private static final Logger log = LoggerFactory.getLogger(PlanningAction.class);

    private final GraphAuxiliaryModelResolver auxiliaryModelResolver;
    private final PromptRegistry promptRegistry;
    private final ObjectMapper mapper;
    private final GraphSkillSupport graphSkillSupport;
    private final io.codepilot.core.graph.ContextShardStore shardStore;
    private final io.codepilot.core.graph.PhaseAwareMemoryLoader phaseAwareMemoryLoader;
    private final io.codepilot.core.run.GraphEngineProperties graphProperties;

    public PlanningAction(
            GraphAuxiliaryModelResolver auxiliaryModelResolver,
            PromptRegistry promptRegistry,
            ObjectMapper mapper,
            GraphSkillSupport graphSkillSupport,
            io.codepilot.core.graph.ContextShardStore shardStore,
            io.codepilot.core.graph.PhaseAwareMemoryLoader phaseAwareMemoryLoader,
            io.codepilot.core.run.GraphEngineProperties graphProperties) {
        this.auxiliaryModelResolver = auxiliaryModelResolver;
        this.promptRegistry = promptRegistry;
        this.mapper = mapper;
        this.graphSkillSupport = graphSkillSupport;
        this.shardStore = shardStore;
        this.phaseAwareMemoryLoader = phaseAwareMemoryLoader;
        this.graphProperties = graphProperties;
    }

    @Override
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "planning");
        GraphExecutionLog.nodeEnter(state, "planning");

        String input = (String) state.value("input").orElse("");
        String mode = (String) state.value("mode").orElse("AGENT");

        // ── Build planning prompt ──
        String projectMeta = (String) state.value("projectMeta").orElse("");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> mcpTools = (List<Map<String, Object>>) state.value("mcpTools").orElse(List.of());
        var skillActivation = graphSkillSupport.activate(state, GraphSkillNode.PLANNING, updates);
        String planningPrompt =
                buildPlanningPrompt(state, input, mode, projectMeta, mcpTools) + skillActivation.promptSection();

        GraphUiEmitter.transition(state, "planning");

        // ── Call LLM (marker-aware streaming) ──
        String llmResponse;
        try {
            llmResponse =
                    auxiliaryModelResolver.streamUserPromptToSse(
                            state, "planning", planningPrompt, updates);
        } catch (Exception e) {
            log.error("LLM planning call failed", e);
            var fallback = buildFallbackPlan(state, input, updates);
            GraphExecutionLog.nodeExit(state, "planning", fallback);
            return fallback;
        }

        // ── Parse LLM response ──
        try {
            var result = parseLlmPlan(llmResponse, state, input, updates);
            GraphExecutionLog.nodeExit(state, "planning", result);
            return result;
        } catch (Exception e) {
            String trimmed = llmResponse != null ? llmResponse.trim() : "";
            if (!trimmed.isEmpty() && !trimmed.startsWith("{")
                && !trimmed.contains(GraphStreamProcessor.MARKER_GRAPH)) {
                log.info("PlanningAction: treating response as plain-text (skipPlan)");
                if (!Boolean.TRUE.equals(updates.get("plainTextStreamed"))
                    && !Boolean.TRUE.equals(updates.get("agentContentStreamed"))) {
                    GraphSseHelper.emitStreamDelta(state, llmResponse);
                }
                updates.put("skipPlan", true);
                var minimal = buildMinimalPhases(state, input, updates);
                GraphExecutionLog.nodeExit(state, "planning", minimal);
                return minimal;
            }
            log.warn("Failed to parse LLM planning response, using fallback. Response: {}",
                llmResponse != null ? llmResponse.substring(0, Math.min(llmResponse.length(), 500)) : "null", e);
            var fallback = buildFallbackPlan(state, input, updates);
            GraphExecutionLog.nodeExit(state, "planning", fallback);
            return fallback;
        }
    }

    private String buildPlanningPrompt(
            OverAllState state, String input, String mode, String projectMeta, List<Map<String, Object>> mcpTools) {
        String template = promptRegistry.get("graph.planning");
        String projectMetaSection = projectMeta.isBlank() ? ""
                : "[PROJECT CONTEXT]\n" + projectMeta + "\n";

        // ★ Build MCP tools section for prompt injection
        String mcpToolsSection = buildMcpToolsSection(mcpTools);

        // ── For super-complex tasks with split context, inject shard summaries instead of full input ──
        // When input has been split into shards by ContextSplitAction, the full input would
        // exceed LLM context limits. We inject a structured summary of available shards
        // so the planner LLM can understand the task scope without reading every detail.
        String contextSection = buildContextSectionForPlanning(state, input);

        return template
                .replace("{{projectMeta}}", projectMetaSection)
                .replace("{{input}}", contextSection)
                .replace("{{userLocale}}", "与用户输入语言一致")
                .replace("{{mcpTools}}", mcpToolsSection);
    }

    /**
     * Build the context section for the planning prompt.
     *
     * <p>When the input has been split into shards (contextSplitResult="split"),
     * inject a structured summary of available shards instead of the full input.
     * This prevents the prompt from exceeding LLM context limits on super-complex tasks.
     *
     * <p>When no shards exist, return the raw input unchanged.
     */
    @SuppressWarnings("unchecked")
    private String buildContextSectionForPlanning(OverAllState state, String rawInput) {
        String splitResult = (String) state.value("contextSplitResult").orElse("");
        if (!"split".equals(splitResult)) {
            return rawInput;
        }

        String projectRootHash = (String) state.value("projectRootHash").orElse("");
        String contextSourceId = (String) state.value("contextSourceId").orElse("");
        if (projectRootHash.isBlank() || contextSourceId.isBlank()) {
            return rawInput;
        }

        // Load all shards to build a structured summary
        List<io.codepilot.core.graph.ContextShardStore.ContextShard> shards;
        try {
            shards = shardStore.loadAll(projectRootHash, contextSourceId).block();
            if (shards == null || shards.isEmpty()) {
                return rawInput;
            }
        } catch (Exception e) {
            log.warn("PlanningAction: failed to load context shards for planning prompt (falling back to raw input): {}",
                    e.getMessage());
            return rawInput;
        }

        // Build structured summary: for each shard, show id + tags + first 200 chars of content
        int shardCount = shards.size();
        StringBuilder sb = new StringBuilder();
        sb.append("[LARGE INPUT — split into ").append(shardCount).append(" context sections]\n");
        sb.append("The user's input has been split into ").append(shardCount)
                .append(" sections for processing. Each section is described below.\n");
        sb.append("When planning phases, reference sections by their ID/tags so the execution engine\n");
        sb.append("can load only the relevant sections for each phase.\n\n");

        int totalChars = 0;
        int maxChars = graphProperties.getPlanningShardSummaryMaxChars() > 0
                ? graphProperties.getPlanningShardSummaryMaxChars() : 32000;
        for (var shard : shards) {
            if (totalChars > maxChars) {
                sb.append("(... ").append(shardCount - shards.indexOf(shard))
                        .append(" more sections truncated for budget)\n");
                break;
            }
            sb.append("── Section: ").append(shard.id()).append(" ──\n");
            sb.append("  Tags: ").append(String.join(", ", shard.tags())).append("\n");
            sb.append("  Type: ").append(shard.contentType()).append("\n");
            // Use LLM-generated summary if available, otherwise first 300 chars as preview
            String preview;
            if (shard.summary() != null && !shard.summary().isBlank()) {
                preview = shard.summary();
            } else if (shard.content().length() > 300) {
                preview = shard.content().substring(0, 300) + "...";
            } else {
                preview = shard.content();
            }
            sb.append("  Preview: ").append(preview).append("\n\n");
            totalChars += preview.length() + 100;
        }

        log.info("PlanningAction: injected {} shard summaries ({} chars) instead of raw input ({} chars)",
                shardCount, totalChars, rawInput.length());
        return sb.toString();
    }

    /**
     * Builds a prompt section describing available MCP tools.
     * Same format as GenerateAction's buildMcpToolsSection.
     */
    private String buildMcpToolsSection(List<Map<String, Object>> mcpTools) {
        if (mcpTools == null || mcpTools.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder("\n[MCP TOOLS — available for infoRequests with kind=\"mcp.call\"]\n");
        sb.append("You can call MCP tools by setting infoRequests with kind=\"mcp.call\".\n");
        sb.append("Each mcp.call request must have args with: {\"fullName\": \"mcp.<serverId>.<toolName>\", \"arguments\": {...}}\n");
        sb.append("Available MCP tools:\n");
        for (Map<String, Object> tool : mcpTools) {
            String fullName = String.valueOf(tool.getOrDefault("name", "unknown"));
            String desc = String.valueOf(tool.getOrDefault("description", ""));
            sb.append("  - ").append(fullName);
            if (!desc.isEmpty() && !"null".equals(desc)) {
                sb.append(": ").append(desc);
            }
            Object params = tool.get("parameters");
            if (params instanceof Map<?, ?> paramMap && !paramMap.isEmpty()) {
                sb.append(" (params: ").append(paramMap.keySet()).append(")");
            }
            sb.append("\n");
        }
        sb.append("Example infoRequest for MCP: {\"id\": \"mcp-1\", \"kind\": \"mcp.call\", \"args\": {\"fullName\": \"mcp.<serverId>.<toolName>\", \"arguments\": {}}}\n");
        return sb.toString();
    }

    private Map<String, Object> parseLlmPlan(String llmResponse, OverAllState state, String input, Map<String, Object> updates) throws Exception {
        boolean contentStreamed = Boolean.TRUE.equals(updates.get("agentContentStreamed"));
        boolean thinkingEmitted = Boolean.TRUE.equals(updates.get("agentThinkingEmitted"));

        // Extract JSON from response (may be wrapped in markdown code block or markers)
        String json = LlmJsonExtract.parseableJson(llmResponse);
        JsonNode root = mapper.readTree(json);

        // Check if LLM requests more info
        JsonNode infoRequests = root.get("infoRequests");
        if (infoRequests != null && !infoRequests.isNull() && infoRequests.isArray() && !infoRequests.isEmpty()) {
            updates.put("planningResult", "infoRequests");
            updates.put("infoRequests", mapper.convertValue(infoRequests, new TypeReference<List<Map<String, Object>>>() {}));
            String phaseId = (String) state.value("phaseCursor").orElse("");
            JsonNode agentThinkingNode = root.get("agentThinking");
            if (agentThinkingNode != null && !agentThinkingNode.isNull() && !agentThinkingNode.asText("").isBlank()) {
                updates.put("agentGatherIntent", agentThinkingNode.asText());
            }
            GraphUiEmitter.thinkingIfPresent(state, root, phaseId, thinkingEmitted);
            GraphUiEmitter.contentIfPresent(state, root, contentStreamed);
            return updates;
        }

        // ★ Check skipPlan flag — LLM decides if this task is simple enough to skip detailed planning
        boolean skipPlan = false;
        JsonNode skipPlanNode = root.get("skipPlan");
        if (skipPlanNode != null && !skipPlanNode.isNull() && skipPlanNode.asBoolean(false)) {
            skipPlan = true;
            log.info("PlanningAction: LLM set skipPlan=true — simple task, skipping detailed plan display");
        }
        updates.put("skipPlan", skipPlan);

        String phaseId = (String) state.value("phaseCursor").orElse("");

        GraphUiEmitter.contentIfPresent(state, root, contentStreamed);
        GraphUiEmitter.thinkingIfPresent(state, root, phaseId, thinkingEmitted);

        // Parse user plan — only emit user_plan event when NOT skipping plan display
        JsonNode userPlanNode = root.get("userPlan");
        Map<String, Object> userPlan;
        List<Map<String, Object>> userSteps;
        if (userPlanNode != null && !userPlanNode.isNull()) {
            @SuppressWarnings("unchecked")
            Map<String, Object> converted = mapper.convertValue(userPlanNode, Map.class);
            userPlan = converted;
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> steps = (List<Map<String, Object>>) userPlan.getOrDefault("steps", List.of());
            userSteps = steps;
        } else {
            userSteps = List.of(
                Map.of("id", "s1", "index", 1, "title", input, "description", input, "status", "in_progress")
            );
            userPlan = Map.of("goal", input, "summary", input, "steps", userSteps, "status", "in_progress");
        }

        // ★ Only emit user_plan SSE event when LLM didn't skip planning
        // When skipPlan=true, we still store userPlan in state but don't show it in the UI
        if (!skipPlan) {
            GraphSseHelper.emitEvent(state, SseEvents.USER_PLAN, userPlan);
            if (!userSteps.isEmpty()) {
                UserPlanProgressHelper.emitByIndex(state, 0, "in_progress", null);
            }
        }
        updates.put("userPlan", userPlan);

        // Parse execution phases
        JsonNode phasesNode = root.get("phases");
        List<Map<String, Object>> phases;
        if (phasesNode != null && !phasesNode.isNull() && phasesNode.isArray()) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> convertedPhases = mapper.convertValue(phasesNode, List.class);
            phases = convertedPhases;
        } else {
            phases = List.of(
                Map.of("id", "p1", "title", "Implementation", "intent", "code-change",
                       "entry", List.of(), "exit", List.of(), "budget", Map.of("attempts", 3))
            );
        }

        // Ensure at least one phase exists
        if (phases.isEmpty()) {
            phases = List.of(
                Map.of("id", "p1", "title", "Implementation", "intent", "code-change",
                       "entry", List.of(), "exit", List.of(), "budget", Map.of("attempts", 3))
            );
        }

        var normalizedPlan = PhasePlanNormalizer.normalizePlan(userSteps, phases);
        userSteps = normalizedPlan.steps();
        phases = applyPhaseDefaults(normalizedPlan.phases());
        userPlan = new LinkedHashMap<>(userPlan);
        userPlan.put("steps", userSteps);
        updates.put("userPlan", userPlan);
        updates.put("userPlanStepCursor", 0);

        GraphSseHelper.emitEvent(state, SseEvents.GRAPH_PLAN,
            Map.of("phases", phases, "graphId", "gph-" + UUID.randomUUID().toString().substring(0, 8)));
        updates.put("phases", phases);
        updates.put("phaseCursor", phases.get(0).get("id"));

        // ── Hierarchical planning support ──
        // When phases contain macroPhase=true markers, store the full macro plan
        // and only expand the first macro-phase's micro-phases for execution.
        // Remaining macro-phases are expanded dynamically by DynamicPlanExpandAction.
        List<Map<String, Object>> macroPhases = phases.stream()
                .filter(p -> Boolean.TRUE.equals(p.get("macroPhase")))
                .toList();
        if (!macroPhases.isEmpty()) {
            log.info("PlanningAction: hierarchical plan detected — {} macro-phases, expanding first", macroPhases.size());
            // Store the full macro plan for later expansion
            updates.put("macroPhases", macroPhases);
            updates.put("macroPhaseCursor", 0);
            updates.put("hierarchicalPlan", true);

            // Extract micro-phases from the first macro-phase (if any embedded)
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> firstMicroPhases =
                    (List<Map<String, Object>>) macroPhases.get(0).getOrDefault("microPhases", List.of());
            if (!firstMicroPhases.isEmpty()) {
                // Mark first micro-phases as internal (user-invisible) — same as
                // DynamicPlanExpandAction does for subsequent macro-phases.
                List<Map<String, Object>> markedFirstMicro = new ArrayList<>();
                for (Map<String, Object> mp : firstMicroPhases) {
                    Map<String, Object> marked = new LinkedHashMap<>(PhaseMemoryHelper.withDefaults(mp));
                    marked.put("internalPhase", true);
                    marked.put("macroPhaseIndex", 0);
                    markedFirstMicro.add(marked);
                }
                // Replace phases with the first macro-phase's micro-phases
                var normalizedMicro = PhasePlanNormalizer.normalizePlan(userSteps, markedFirstMicro);
                updates.put("phases", normalizedMicro.phases());
                updates.put("phaseCursor", normalizedMicro.phases().get(0).get("id"));
                log.info("PlanningAction: expanded first macro-phase into {} micro-phases", normalizedMicro.phases().size());
            }
        } else {
            updates.put("hierarchicalPlan", false);
        }

        // Load project memory + shards for the first execution phase (memoryLoad runs before planning).
        if (!phases.isEmpty()) {
            String firstPhaseId = String.valueOf(phases.get(0).get("id"));
            try {
                phaseAwareMemoryLoader.loadForNextPhase(state, updates, firstPhaseId);
            } catch (Exception e) {
                log.warn("PlanningAction: first-phase memory load failed (non-fatal): {}", e.getMessage());
            }
        }

        updates.put("planningResult", "phases");
        return updates;
    }

    private static List<Map<String, Object>> applyPhaseDefaults(List<Map<String, Object>> phases) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> phase : phases) {
            out.add(PhaseMemoryHelper.withDefaults(phase));
        }
        return out;
    }

    private Map<String, Object> buildFallbackPlan(OverAllState state, String input, Map<String, Object> updates) {
        updates.put("skipPlan", true);
        return buildMinimalPhases(state, input, updates);
    }

    private Map<String, Object> buildMinimalPhases(OverAllState state, String input, Map<String, Object> updates) {
        List<Map<String, Object>> userSteps = List.of(
            Map.of("id", "s1", "index", 1, "title", input, "description", input, "status", "in_progress")
        );
        updates.put("userPlan", Map.of("goal", input, "summary", input, "steps", userSteps, "status", "in_progress"));

        List<Map<String, Object>> phases = List.of(
            Map.of("id", "p1", "title", "Implementation", "intent", "code-change",
                   "entry", List.of(), "exit", List.of(), "budget", Map.of("attempts", 3))
        );
        GraphSseHelper.emitEvent(state, SseEvents.GRAPH_PLAN,
            Map.of("phases", phases, "graphId", "gph-" + UUID.randomUUID().toString().substring(0, 8)));
        updates.put("phases", phases);
        updates.put("phaseCursor", "p1");
        updates.put("planningResult", "phases");
        return updates;
    }

    private String extractJson(String response) {
        if (response == null) return "{}";
        // Try to extract JSON from markdown code block
        String trimmed = response.trim();
        if (trimmed.startsWith("```")) {
            int start = trimmed.indexOf('\n') + 1;
            int end = trimmed.lastIndexOf("```");
            if (end > start) {
                return trimmed.substring(start, end).trim();
            }
        }
        // Try to find the first { ... } block
        int braceStart = trimmed.indexOf('{');
        int braceEnd = trimmed.lastIndexOf('}');
        if (braceStart >= 0 && braceEnd > braceStart) {
            return trimmed.substring(braceStart, braceEnd + 1);
        }
        return trimmed;
    }

    /**
     * Conditional edge router: determines next node after planning.
     */
    public String routeAfterPlanning(OverAllState state) {
        String result = (String) state.value("planningResult").orElse("phases");
        boolean gatherExhausted = Boolean.TRUE.equals(state.value("gatherExhausted").orElse(false));
        int gatherCount = (int) state.value("gatherCount").orElse(0);

        // ★ Anti-loop: when gather has already been executed multiple times,
        // refuse to route back to gather from planning.
        if ("infoRequests".equals(result) && (gatherExhausted || gatherCount >= 3)) {
            log.warn("PlanningAction: LLM output infoRequests but gather budget exceeded "
                + "(gatherCount={}, gatherExhausted={}). Forcing to preCheck.", gatherCount, gatherExhausted);
            return "preCheck";
        }

        return switch (result) {
            case "infoRequests" -> "gather";
            case "error" -> "summarize";
            default -> "preCheck";
        };
    }
}
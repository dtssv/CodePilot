package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.model.ModelSource;
import io.codepilot.core.prompt.PromptRegistry;
import io.codepilot.core.sse.SseEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
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

    private final ChatClientFactory chatClientFactory;
    private final PromptRegistry promptRegistry;
    private final ObjectMapper mapper;

    public PlanningAction(ChatClientFactory chatClientFactory, PromptRegistry promptRegistry, ObjectMapper mapper) {
        this.chatClientFactory = chatClientFactory;
        this.promptRegistry = promptRegistry;
        this.mapper = mapper;
    }

    @Override
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "planning");

        String input = (String) state.value("input").orElse("");
        String mode = (String) state.value("mode").orElse("AGENT");

        // ── Build planning prompt ──
        String planningPrompt = buildPlanningPrompt(input, mode);

        // ── Call LLM ──
        String llmResponse;
        try {
            String modelId = (String) state.value("modelId").orElse(null);
            String modelSourceName = (String) state.value("modelSource").orElse(null);
            String userId = (String) state.value("userId").orElse(null);
            ModelSource modelSource = modelSourceName != null ? ModelSource.valueOf(modelSourceName) : null;
            log.info("PlanningAction resolving model: modelId={}, modelSource={}, userId={}", modelId, modelSourceName, userId);
            ChatClient chatClient = chatClientFactory.resolve(modelId, modelSource, userId).chatClient();
            llmResponse = chatClient.prompt()
                    .system(promptRegistry.get("agent.system"))
                    .user(planningPrompt)
                    .call()
                    .content();
        } catch (Exception e) {
            log.error("LLM planning call failed", e);
            // Fallback to default plan
            return buildFallbackPlan(state, input, updates);
        }

        // ── Parse LLM response ──
        try {
            return parseLlmPlan(llmResponse, state, input, updates);
        } catch (Exception e) {
            log.warn("Failed to parse LLM planning response, using fallback", e);
            return buildFallbackPlan(state, input, updates);
        }
    }

    private String buildPlanningPrompt(String input, String mode) {
        String template = promptRegistry.get("graph.planning");
        return template
                .replace("{{input}}", input)
                .replace("{{userLocale}}", "zh-CN");
    }

    private Map<String, Object> parseLlmPlan(String llmResponse, OverAllState state, String input, Map<String, Object> updates) throws Exception {
        // Extract JSON from response (may be wrapped in markdown code block)
        String json = extractJson(llmResponse);
        JsonNode root = mapper.readTree(json);

        // Check if LLM requests more info
        JsonNode infoRequests = root.get("infoRequests");
        if (infoRequests != null && !infoRequests.isNull() && infoRequests.isArray() && !infoRequests.isEmpty()) {
            updates.put("planningResult", "infoRequests");
            updates.put("infoRequests", mapper.convertValue(infoRequests, List.class));
            return updates;
        }

        // Parse user plan
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

        GraphSseHelper.emitEvent(state, SseEvents.USER_PLAN, userPlan);
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

        GraphSseHelper.emitEvent(state, SseEvents.GRAPH_PLAN,
            Map.of("phases", phases, "graphId", "gph-" + UUID.randomUUID().toString().substring(0, 8)));
        updates.put("phases", phases);
        updates.put("phaseCursor", phases.get(0).get("id"));

        updates.put("planningResult", "phases");
        return updates;
    }

    private Map<String, Object> buildFallbackPlan(OverAllState state, String input, Map<String, Object> updates) {
        // Single-phase fallback
        List<Map<String, Object>> userSteps = List.of(
            Map.of("id", "s1", "index", 1, "title", input, "description", input, "status", "in_progress")
        );
        var userPlan = Map.of("goal", input, "summary", input, "steps", userSteps, "status", "in_progress");
        GraphSseHelper.emitEvent(state, SseEvents.USER_PLAN, userPlan);
        updates.put("userPlan", userPlan);

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
        return switch (result) {
            case "infoRequests" -> "gather";
            case "error" -> "finalize";
            default -> "preCheck";
        };
    }
}
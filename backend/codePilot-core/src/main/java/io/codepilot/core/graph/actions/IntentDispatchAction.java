package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.*;
import io.codepilot.core.graph.skill.GraphSkillNode;
import io.codepilot.core.graph.skill.GraphSkillSupport;
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
 * Intent dispatch node: handles lightweight paths that do NOT need the full
 * graph pipeline (planning → generate → applyPatch → verify → commit).
 *
 * <p>Routes after intake based on {@link IntakeIntent.DispatchPath}:
 * <ul>
 *   <li>{@code CONVERSATIONAL} — pure Q&A, calls LLM directly, streams answer, then finalize</li>
 *   <li>{@code MCP_DIRECT} — delegates MCP tool invocation to the plugin via SSE,
 *       then finalize</li>
 *   <li>{@code SKILL_DIRECT} — activates matching skill, calls LLM with skill prompt,
 *       streams answer, then finalize</li>
 * </ul>
 *
 * <p>If none of the above applies, the graph routes to the normal pipeline
 * (planning → …) instead of entering this node.
 */
@Component
public class IntentDispatchAction implements NodeAction {

    private static final Logger log = LoggerFactory.getLogger(IntentDispatchAction.class);

    private final ChatClientFactory chatClientFactory;
    private final PromptRegistry promptRegistry;
    private final GraphSkillSupport graphSkillSupport;

    public IntentDispatchAction(
            ChatClientFactory chatClientFactory,
            PromptRegistry promptRegistry,
            GraphSkillSupport graphSkillSupport) {
        this.chatClientFactory = chatClientFactory;
        this.promptRegistry = promptRegistry;
        this.graphSkillSupport = graphSkillSupport;
    }

    @Override
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "intentDispatch");
        GraphExecutionLog.nodeEnter(state, "intentDispatch");

        String sessionId = (String) state.value("sessionId").orElse("");
        String input = (String) state.value("input").orElse("");
        String projectMeta = (String) state.value("projectMeta").orElse("");

        @SuppressWarnings("unchecked")
        Map<String, Object> intakeIntent =
                (Map<String, Object>) state.value("intakeIntent").orElse(Map.of());
        String dispatchPathStr =
                String.valueOf(intakeIntent.getOrDefault("dispatchPath", "GRAPH"));
        IntakeIntent.DispatchPath dispatchPath;
        try {
            dispatchPath = IntakeIntent.DispatchPath.valueOf(dispatchPathStr);
        } catch (IllegalArgumentException e) {
            dispatchPath = IntakeIntent.DispatchPath.GRAPH;
        }

        log.info("IntentDispatchAction: dispatchPath={}, inputPreview={}",
                dispatchPath, input.substring(0, Math.min(input.length(), 80)));

        switch (dispatchPath) {
            case CONVERSATIONAL -> handleConversational(state, updates, input, projectMeta);
            case MCP_DIRECT -> handleMcpDirect(state, updates, input);
            case SKILL_DIRECT -> handleSkillDirect(state, updates, input, projectMeta);
            default -> {
                // Should not reach here — GRAPH path bypasses this node entirely
                log.warn("IntentDispatchAction: unexpected GRAPH dispatch, falling back to finalize");
                updates.put("doneReason", "dispatch_fallback");
            }
        }

        GraphExecutionLog.nodeExit(state, "intentDispatch", updates);
        return updates;
    }

    /**
     * Pure conversational Q&A — call LLM with conversational prompt,
     * stream the response directly to the client, then finalize.
     */
    private void handleConversational(
            OverAllState state, Map<String, Object> updates,
            String input, String projectMeta) {

        GraphUiEmitter.transition(state, "conversational");

        String prompt = buildConversationalPrompt(input, projectMeta);
        String llmResponse = callLlm(state, prompt);

        // Stream the response to the client
        if (llmResponse != null && !llmResponse.isBlank()) {
            String display = GraphMarkerSanitizer.stripForDisplay(llmResponse).trim();
            if (!display.isBlank()) {
                GraphSseHelper.emitEvent(state, SseEvents.DELTA, Map.of("text", display));
            }
        }

        updates.put("doneReason", "conversational");
        updates.put("generateResult", "textOutput");
        log.info("IntentDispatchAction: conversational answer completed");
    }

    /**
     * MCP tool direct — emit an MCP tool_call SSE so the plugin executes the tool,
     * then finalize. The plugin will send the tool result back on the next turn.
     */
    @SuppressWarnings("unchecked")
    private void handleMcpDirect(
            OverAllState state, Map<String, Object> updates, String input) {

        GraphUiEmitter.transition(state, "mcp_direct");

        // Get MCP tool hints from intake classification
        @SuppressWarnings("unchecked")
        Map<String, Object> intakeIntent =
                (Map<String, Object>) state.value("intakeIntent").orElse(Map.of());
        List<Map<String, Object>> tools =
                (List<Map<String, Object>>) intakeIntent.getOrDefault("tools", List.of());

        // Get available MCP tool definitions from state (provided by plugin)
        List<Map<String, Object>> mcpTools =
                (List<Map<String, Object>>) state.value("mcpTools").orElse(List.of());

        // Find the matching MCP tool definition
        List<Map<String, Object>> matchedMcpTools = new ArrayList<>();
        Set<String> hintedNames = new HashSet<>();
        for (Map<String, Object> t : tools) {
            String name = String.valueOf(t.getOrDefault("name", ""));
            if (name.startsWith("mcp.")) {
                hintedNames.add(name);
            }
        }
        for (Map<String, Object> mcp : mcpTools) {
            String name = String.valueOf(mcp.getOrDefault("name", ""));
            if (hintedNames.contains(name)) {
                matchedMcpTools.add(mcp);
            }
        }

        if (matchedMcpTools.isEmpty()) {
            // No matching MCP tool found — fall back to conversational answer
            log.warn("IntentDispatchAction: MCP_DIRECT but no matching MCP tool found, falling back to conversational");
            String projectMeta = (String) state.value("projectMeta").orElse("");
            handleConversational(state, updates, input, projectMeta);
            return;
        }

        // Emit tool_call SSE for each matched MCP tool so the plugin executes them
        for (Map<String, Object> mcpTool : matchedMcpTools) {
            String toolName = String.valueOf(mcpTool.getOrDefault("name", ""));
            Map<String, Object> args = extractMcpArgs(mcpTool, input);
            String callId = "mcp-" + UUID.randomUUID().toString().substring(0, 8);

            Map<String, Object> toolCall = new LinkedHashMap<>();
            toolCall.put("id", callId);
            toolCall.put("name", toolName);
            toolCall.put("args", args);

            GraphSseHelper.emitEvent(state, SseEvents.TOOL_CALL, toolCall);
            log.info("IntentDispatchAction: emitted MCP tool_call name={}, callId={}", toolName, callId);
        }

        updates.put("doneReason", "mcp_direct");
        updates.put("generateResult", "toolCalls");
        log.info("IntentDispatchAction: MCP direct dispatch completed, {} tools emitted", matchedMcpTools.size());
    }

    /**
     * Skill direct — activate matching skills, call LLM with skill-augmented prompt,
     * stream the response, then finalize.
     */
    private void handleSkillDirect(
            OverAllState state, Map<String, Object> updates,
            String input, String projectMeta) {

        GraphUiEmitter.transition(state, "skill_direct");

        // Activate skills for the INTAKE node scope
        var skillActivation = graphSkillSupport.activate(state, GraphSkillNode.INTAKE, updates);
        String skillSection = skillActivation.promptSection();

        String prompt = buildConversationalPrompt(input, projectMeta);
        if (!skillSection.isBlank()) {
            prompt += "\n\n[SKILL INSTRUCTIONS]\n" + skillSection;
        }

        String llmResponse = callLlm(state, prompt);

        if (llmResponse != null && !llmResponse.isBlank()) {
            String display = GraphMarkerSanitizer.stripForDisplay(llmResponse).trim();
            if (!display.isBlank()) {
                GraphSseHelper.emitEvent(state, SseEvents.DELTA, Map.of("text", display));
            }
        }

        updates.put("doneReason", "skill_direct");
        updates.put("generateResult", "textOutput");
        log.info("IntentDispatchAction: skill direct answer completed, skills={}",
                skillActivation.skills().stream().map(s -> s.id()).toList());
    }

    // ── Helpers ──

    private String buildConversationalPrompt(String input, String projectMeta) {
        String template = promptRegistry.get("graph.conversational");
        String projectMetaSection =
                projectMeta.isBlank() ? "" : "[PROJECT CONTEXT]\n" + projectMeta + "\n";
        return template
                .replace("{{projectMeta}}", projectMetaSection)
                .replace("{{input}}", input);
    }

    private String callLlm(OverAllState state, String prompt) {
        try {
            String modelId = (String) state.value("modelId").orElse(null);
            String modelSourceName = (String) state.value("modelSource").orElse(null);
            String userId = (String) state.value("userId").orElse(null);
            ModelSource modelSource =
                    modelSourceName != null ? ModelSource.valueOf(modelSourceName) : null;
            ChatClient chatClient = chatClientFactory.resolve(modelId, modelSource, userId).chatClient();

            GraphExecutionLog.llmRequest(state, "intentDispatch", prompt);
            String response = GraphLlmHelper.completeUserPrompt(chatClient, state, prompt);
            GraphExecutionLog.llmResponse(state, "intentDispatch", response, Map.of());
            return response;
        } catch (Exception e) {
            log.error("IntentDispatchAction: LLM call failed: {}", e.getMessage());
            return "抱歉，我暂时无法回答您的问题，请稍后重试。";
        }
    }

    /**
     * Extracts minimal args for an MCP tool call. For simple dispatch, we pass
     * the user's input as context. The plugin will fill in detailed args based on
     * the tool schema and user interaction.
     */
    @SuppressWarnings("unchecked")
    private Map<String, Object> extractMcpArgs(Map<String, Object> mcpTool, String input) {
        // If the MCP tool has a parameters schema with required fields,
        // let the plugin handle arg extraction via its own UI.
        // We pass the raw input as a hint for the plugin.
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("_userInput", input);
        // Also forward any default/example args from the tool definition
        Object params = mcpTool.get("parameters");
        if (params instanceof Map<?, ?> paramMap) {
            Object defaultProps = ((Map<String, Object>) paramMap).get("default");
            if (defaultProps instanceof Map<?, ?> defaults) {
                ((Map<String, Object>) defaults).forEach(args::putIfAbsent);
            }
        }
        return args;
    }

    /**
     * Route after intentDispatch — always goes to finalize since this is a
     * terminal shortcut node.
     */
    public String routeAfterIntentDispatch(OverAllState state) {
        return "finalize";
    }
}
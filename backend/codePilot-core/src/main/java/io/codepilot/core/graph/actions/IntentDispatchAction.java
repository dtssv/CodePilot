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
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Intent dispatch node: handles lightweight paths that do NOT need the full
 * graph pipeline (planning → generate → applyPatch → verify → commit).
 *
 * <p>Routes after intake based on {@link IntakeIntent.DispatchPath},
 * which is determined by <b>task complexity</b>, not tool type:
 * <ul>
 *   <li>{@code CONVERSATIONAL} — pure Q&A, no tools, no planning</li>
 *   <li>{@code SIMPLE} — needs tools but no multi-step plan; MCP tools
 *       and Skills are injected as <b>execution resources</b>, not routing targets</li>
 * </ul>
 *
 * <p>Design principle: MCP tools and Skills are resources available during
 * execution, not routing destinations. The SIMPLE path may use MCP tools,
 * Skills, built-in tools, or any combination — the dispatch decision is based
 * on whether the task needs multi-step planning, not on tool type.
 *
 * <p>If the task needs planning, the graph routes to the normal pipeline
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
            case SIMPLE -> handleSimple(state, updates, input, projectMeta);
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
     * Simple tool-assisted execution — needs tools but no multi-step plan.
     *
     * <p>This path handles tasks that require tool assistance (MCP, Skill,
     * built-in tools) but don't need multi-step planning. MCP tools and Skills
     * are treated as <b>execution resources</b> — they are injected into the
     * prompt/tool execution, not used as routing targets.
     *
     * <p>Strategy:
     * <ol>
     *   <li>If intent-suggested tools are exclusively MCP tools → emit tool_call SSE
     *       for the plugin to execute (fastest path for "query this API" tasks)</li>
     *   <li>Otherwise → call LLM with tool descriptions + skill prompt injected,
     *       let LLM decide how to use the available resources</li>
     * </ol>
     */
    @SuppressWarnings("unchecked")
    private void handleSimple(
            OverAllState state, Map<String, Object> updates,
            String input, String projectMeta) {

        GraphUiEmitter.transition(state, "simple_dispatch");

        // ── Collect available execution resources ──
        // 1. MCP tools (from plugin request)
        List<Map<String, Object>> mcpTools =
                (List<Map<String, Object>>) state.value("mcpTools").orElse(List.of());

        // 2. Intent-suggested tools (from LLM classification)
        Map<String, Object> intakeIntent =
                (Map<String, Object>) state.value("intakeIntent").orElse(Map.of());
        List<Map<String, Object>> suggestedTools =
                (List<Map<String, Object>>) intakeIntent.getOrDefault("tools", List.of());

        // 3. Skills (activated for this context)
        var skillActivation = graphSkillSupport.activate(state, GraphSkillNode.INTAKE, updates);

        // ── Fast path: if ALL suggested tools are MCP tools, emit tool_call SSE directly ──
        // This preserves the low-latency path for "query this API" type tasks.
        boolean allMcpTools = !suggestedTools.isEmpty()
                && suggestedTools.stream().allMatch(t ->
                        String.valueOf(t.getOrDefault("name", "")).startsWith("mcp."));

        if (allMcpTools) {
            Set<String> hintedNames = suggestedTools.stream()
                    .map(t -> String.valueOf(t.getOrDefault("name", "")))
                    .filter(n -> n.startsWith("mcp."))
                    .collect(java.util.stream.Collectors.toSet());

            List<Map<String, Object>> matchedMcpTools = new ArrayList<>();
            for (Map<String, Object> mcp : mcpTools) {
                String name = String.valueOf(mcp.getOrDefault("name", ""));
                if (hintedNames.contains(name)) {
                    matchedMcpTools.add(mcp);
                }
            }

            if (!matchedMcpTools.isEmpty()) {
                // Emit tool_call SSE for each matched MCP tool
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

                updates.put("doneReason", "simple_mcp");
                updates.put("generateResult", "toolCalls");
                log.info("IntentDispatchAction: simple dispatch completed (MCP fast path), {} tools emitted",
                        matchedMcpTools.size());
                return;
            }
        }

        // ── General path: call LLM with all resources injected ──
        // Build prompt with: project context + tool descriptions + skill instructions
        String prompt = buildConversationalPrompt(input, projectMeta);

        // Inject MCP tool descriptions as available resources
        if (!mcpTools.isEmpty()) {
            prompt += "\n\n[AVAILABLE TOOLS]\nYou have the following tools available:\n";
            for (Map<String, Object> tool : mcpTools) {
                String fullName = String.valueOf(tool.getOrDefault("name", "unknown"));
                String desc = String.valueOf(tool.getOrDefault("description", ""));
                prompt += "  - " + fullName;
                if (!desc.isEmpty() && !"null".equals(desc)) {
                    prompt += ": " + desc;
                }
                prompt += "\n";
            }
            prompt += "If you need to use any of these tools, describe what you would call and why.\n";
        }

        // Inject skill instructions as context
        String skillSection = skillActivation.promptSection();
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

        updates.put("doneReason", "simple");
        updates.put("generateResult", "textOutput");
        log.info("IntentDispatchAction: simple dispatch completed (LLM path, skills={}, mcpTools={})",
                skillActivation.skills().size(), mcpTools.size());
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
            var resolved = chatClientFactory.resolve(modelId, modelSource, userId);

            GraphExecutionLog.llmRequest(state, "intentDispatch", prompt);
            String response = GraphLlmHelper.completeUserPrompt(resolved, state, prompt);
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
     * Route after intentDispatch — always goes to summarize since this is a
     * terminal shortcut node (summarize then finalize).
     */
    public String routeAfterIntentDispatch(OverAllState state) {
        return "summarize";
    }
}
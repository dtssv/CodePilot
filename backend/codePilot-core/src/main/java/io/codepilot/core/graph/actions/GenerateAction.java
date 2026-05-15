package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.dto.Patch;
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
 * Generate node: calls the LLM to produce code changes (patches/toolCalls)
 * for the current phase, or infoRequests if more information is needed.
 *
 * <p>The LLM is prompted to return a JSON envelope with either:
 * <ul>
 *   <li>{@code patches[]} — file edits to be applied by ApplyPatchAction</li>
 *   <li>{@code infoRequests[]} — requests for more information (routes to Gather)</li>
 *   <li>{@code askUser} — question for the user (routes to AskUser)</li>
 * </ul>
 */
@Component
public class GenerateAction implements NodeAction {

    private static final Logger log = LoggerFactory.getLogger(GenerateAction.class);

    private final ChatClientFactory chatClientFactory;
    private final PromptRegistry promptRegistry;
    private final ObjectMapper mapper;

    public GenerateAction(ChatClientFactory chatClientFactory, PromptRegistry promptRegistry, ObjectMapper mapper) {
        this.chatClientFactory = chatClientFactory;
        this.promptRegistry = promptRegistry;
        this.mapper = mapper;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "generate");

        String input = (String) state.value("input").orElse("");
        String phaseId = (String) state.value("phaseCursor").orElse("");
        var userPlan = (Map<String, Object>) state.value("userPlan").orElse(Map.of());
        var phases = (List<Map<String, Object>>) state.value("phases").orElse(List.of());
        var gatheredInfo = (Map<String, Object>) state.value("gatheredInfo").orElse(Map.of());
        String projectMeta = (String) state.value("projectMeta").orElse("");
        int gatherCount = (int) state.value("gatherCount").orElse(0);
        boolean gatherExhausted = Boolean.TRUE.equals(state.value("gatherExhausted").orElse(false));

        // Find current phase details
        Map<String, Object> currentPhase = phases.stream()
                .filter(p -> phaseId.equals(p.get("id")))
                .findFirst()
                .orElse(Map.of());

        // ── Build generate prompt ──
        // When gather has already been executed, force the LLM to produce patches instead of
        // requesting more information. This prevents infinite generate→gather→reenter→generate loops.
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> mcpTools = (List<Map<String, Object>>) state.value("mcpTools").orElse(List.of());
        String generatePrompt = buildGeneratePrompt(input, phaseId, currentPhase, userPlan, gatheredInfo, projectMeta, gatherCount, gatherExhausted, mcpTools);

        // ── Call LLM ──
        String llmResponse;
        try {
            String modelId = (String) state.value("modelId").orElse(null);
            String modelSourceName = (String) state.value("modelSource").orElse(null);
            String userId = (String) state.value("userId").orElse(null);
            ModelSource modelSource = modelSourceName != null ? ModelSource.valueOf(modelSourceName) : null;
            log.info("GenerateAction resolving model: modelId={}, modelSource={}, userId={}", modelId, modelSourceName, userId);
            ChatClient chatClient = chatClientFactory.resolve(modelId, modelSource, userId).chatClient();

            // ★ Build multi-turn context from conversation history
            // Inject previous turns as Spring AI messages so the LLM has
            // conversation continuity across user requests.
            @SuppressWarnings("unchecked")
            List<Map<String, String>> conversationHistory = (List<Map<String, String>>) state.value("conversationHistory").orElse(List.of());

            var promptBuilder = chatClient.prompt().user(generatePrompt);
            if (!conversationHistory.isEmpty()) {
                var messages = new java.util.ArrayList<org.springframework.ai.chat.messages.Message>();
                for (var histMsg : conversationHistory) {
                    String role = histMsg.getOrDefault("role", "");
                    String content = histMsg.getOrDefault("content", "");
                    if (content == null || content.isBlank()) continue;
                    if ("user".equals(role)) {
                        messages.add(new org.springframework.ai.chat.messages.UserMessage(content));
                    } else if ("assistant".equals(role)) {
                        messages.add(new org.springframework.ai.chat.messages.AssistantMessage(content));
                    }
                }
                if (!messages.isEmpty()) {
                    // Include history before the current user prompt
                    var allMessages = new java.util.ArrayList<org.springframework.ai.chat.messages.Message>(messages);
                    allMessages.add(new org.springframework.ai.chat.messages.UserMessage(generatePrompt));
                    var prompt = org.springframework.ai.chat.prompt.Prompt.builder()
                            .messages(allMessages)
                            .build();
                    llmResponse = chatClient.prompt(prompt).call().content();
                } else {
                    llmResponse = chatClient.prompt().user(generatePrompt).call().content();
                }
            } else {
                llmResponse = chatClient.prompt().user(generatePrompt).call().content();
            }
        } catch (Exception e) {
            log.error("LLM generate call failed for phase={}", phaseId, e);
            // LLM call failed — route to askUser so the user can decide how to proceed
            updates.put("generateResult", "askUser");
            updates.put("askUserQuestion", Map.of(
                    "id", "gen-llm-failed-" + phaseId,
                    "text", "Code generation failed: " + e.getMessage(),
                    "kind", "single-choice",
                    "options", List.of(
                            Map.of("id", "retry", "label", "Retry generation"),
                            Map.of("id", "skip", "label", "Skip this phase")
                    )
            ));
            return updates;
        }

        // ── Parse LLM response ──
        GraphSseHelper.emitEvent(state, "graph_transition",
                Map.of("from", "preCheck", "to", "generate", "phaseId", phaseId));

        try {
            return parseGenerateResponse(llmResponse, state, phaseId, updates);
        } catch (Exception e) {
            log.warn("Failed to parse LLM generate response for phase={}, treating as text output", phaseId, e);
            // If we can't parse structured output, wrap the raw text as a delta event
            return handleUnstructuredResponse(llmResponse, state, phaseId, updates);
        }
    }

    private String buildGeneratePrompt(String input, String phaseId,
                                        Map<String, Object> currentPhase,
                                        Map<String, Object> userPlan,
                                        Map<String, Object> gatheredInfo,
                                        String projectMeta,
                                        int gatherCount,
                                        boolean gatherExhausted,
                                        List<Map<String, Object>> mcpTools) {
        String template = promptRegistry.get("graph.generate");
        String gatheredContext = gatheredInfo.isEmpty() ? ""
                : "[GATHERED CONTEXT]\n" + formatGatheredInfo(gatheredInfo);
        String projectMetaSection = projectMeta.isBlank() ? ""
                : "[PROJECT CONTEXT]\n" + projectMeta + "\n";

        // ★ Build MCP tools section for prompt injection
        String mcpToolsSection = buildMcpToolsSection(mcpTools);

        // ★ Anti-loop injection: when gather has already been executed at least once,
        // append a mandatory instruction telling the LLM it MUST NOT request more info.
        // This prevents the generate→gather→reenter→generate infinite loop where the
        // LLM keeps requesting the same files instead of producing code.
        String antiLoopDirective = "";
        if (gatherCount > 0 && !gatheredInfo.isEmpty()) {
            antiLoopDirective = "\n\n[MANDATORY — DO NOT IGNORE]\n"
                + "You have already gathered information (see [GATHERED CONTEXT] above). "
                + "You MUST NOT set infoRequests to anything other than null. "
                + "You MUST produce patches, textOutput, or set askUser instead. "
                + "Do NOT request the same files again — use what you already have. "
                + "If the code already exists and no changes are needed, set textOutput to explain this. "
                + "If you need to make changes, produce your best effort patches.\n";
        }
        if (gatherExhausted) {
            antiLoopDirective += "\n[GATHER BUDGET EXHAUSTED] You have exceeded the maximum number of information-gathering rounds. "
                + "You MUST produce patches or textOutput now. Setting infoRequests will be ignored.\n";
        }

        return template
                .replace("{{projectMeta}}", projectMetaSection)
                .replace("{{input}}", input)
                .replace("{{phaseId}}", phaseId)
                .replace("{{phaseTitle}}", String.valueOf(currentPhase.getOrDefault("title", "")))
                .replace("{{phaseIntent}}", String.valueOf(currentPhase.getOrDefault("intent", "code-change")))
                .replace("{{gatheredContext}}", gatheredContext)
                .replace("{{userLocale}}", "zh-CN")
                .replace("{{mcpTools}}", mcpToolsSection)
                + antiLoopDirective;
    }

    /**
     * Formats gathered info into a human-readable string that the LLM can understand.
     * Each entry is formatted as: "kind: path\n<content snippet>"
     */
    @SuppressWarnings("unchecked")
    private String formatGatheredInfo(Map<String, Object> gatheredInfo) {
        StringBuilder sb = new StringBuilder();
        for (var entry : gatheredInfo.entrySet()) {
            Object value = entry.getValue();
            if (value instanceof Map<?, ?> rawMap) {
                Map<String, Object> map = (Map<String, Object>) rawMap;
                String kind = String.valueOf(map.getOrDefault("kind", "unknown"));
                String id = String.valueOf(map.getOrDefault("id", entry.getKey()));
                boolean ok = Boolean.TRUE.equals(map.get("ok"));

                if (!ok) {
                    sb.append("- [FAILED] ").append(kind).append(" (").append(id).append("): ")
                      .append(map.getOrDefault("errorMessage", "unknown error")).append("\n");
                    continue;
                }

                Object result = map.get("result");
                if (result instanceof Map<?, ?> rawResultMap) {
                    Map<String, Object> resultMap = (Map<String, Object>) rawResultMap;
                    // fs.read result: has "path" and "content"
                    String path = String.valueOf(resultMap.getOrDefault("path", ""));
                    Object content = resultMap.get("content");
                    if (content != null && !content.toString().isBlank()) {
                        String contentStr = content.toString();
                        // Truncate very long file contents
                        if (contentStr.length() > 4000) {
                            contentStr = contentStr.substring(0, 4000) + "\n... (truncated)";
                        }
                        sb.append("- File: ").append(path).append("\n```\n")
                          .append(contentStr).append("\n```\n");
                    } else {
                        // fs.list result: has "path" and "entries"
                        Object entries = resultMap.get("entries");
                        if (entries != null) {
                            sb.append("- Directory listing: ").append(path).append("\n")
                              .append(entries.toString()).append("\n");
                        } else {
                            sb.append("- ").append(kind).append(": ").append(resultMap).append("\n");
                        }
                    }
                } else {
                    sb.append("- ").append(kind).append(" (").append(id).append("): ")
                      .append(value).append("\n");
                }
            } else {
                sb.append("- ").append(entry.getKey()).append(": ").append(value).append("\n");
            }
        }
        return sb.toString();
    }

    private Map<String, Object> parseGenerateResponse(String llmResponse, OverAllState state,
                                                       String phaseId, Map<String, Object> updates) throws Exception {
        String json = extractJson(llmResponse);
        JsonNode root = mapper.readTree(json);

        // ★ Extract agentThinking from LLM output (overrides the preliminary "正在思考...")
        JsonNode agentThinkingNode = root.get("agentThinking");
        String agentThinking = null;
        if (agentThinkingNode != null && !agentThinkingNode.isNull() && !agentThinkingNode.asText("").isBlank()) {
            agentThinking = agentThinkingNode.asText();
        }

        // ★ Extract agentContent from LLM output (structured user-facing content with XML tags)
        JsonNode agentContentNode = root.get("agentContent");
        String agentContent = null;
        if (agentContentNode != null && !agentContentNode.isNull() && !agentContentNode.asText("").isBlank()) {
            agentContent = agentContentNode.asText();
        }

        // Check for infoRequests — LLM may return string elements instead of objects
        JsonNode infoRequests = root.get("infoRequests");
        if (infoRequests != null && !infoRequests.isNull() && infoRequests.isArray() && !infoRequests.isEmpty()) {
            updates.put("generateResult", "infoRequests");
            updates.put("infoRequests", normalizeInfoRequests(infoRequests));
            // ★ Emit agent_thinking with LLM-provided text, and store intent for GatherAction
            String thinkingText = agentThinking != null ? agentThinking : "需要更多信息";
            GraphSseHelper.emitEvent(state, SseEvents.AGENT_THINKING,
                Map.of("text", thinkingText, "phaseId", phaseId));
            updates.put("agentGatherIntent", thinkingText);
            return updates;
        }

        // Check for askUser — LLM may return a plain string instead of an object
        JsonNode askUser = root.get("askUser");
        if (askUser != null && !askUser.isNull()) {
            updates.put("generateResult", "askUser");
            if (askUser.isObject()) {
                updates.put("askUserQuestion", mapper.convertValue(askUser, Map.class));
            } else {
                // Wrap plain string into a structured askUser map matching AskUserAction.buildQuestion() format
                // Use "text" key (not "question") because buildQuestion reads raw.getOrDefault("text", "")
                updates.put("askUserQuestion", Map.of("text", askUser.asText(),
                        "kind", "single-choice",
                        "options", List.of(
                                Map.of("id", "yes", "label", "Yes, proceed"),
                                Map.of("id", "no", "label", "No, reconsider"))));
            }
            return updates;
        }

        // Check for textOutput — LLM explicitly chooses to respond with text instead of code changes
        // (e.g., when code already exists, or an explanation is more appropriate than patches)
        JsonNode textOutput = root.get("textOutput");
        if (textOutput != null && !textOutput.isNull() && !textOutput.asText("").isBlank()) {
            String textStr = textOutput.asText();
            log.info("GenerateAction: LLM returned textOutput for phase={}: {} chars", phaseId, textStr.length());
            // ★ Emit events based on whether agentContent is provided
            if (agentContent != null) {
                // agentContent already includes thinking — just emit it as delta
                GraphSseHelper.emitEvent(state, SseEvents.DELTA, Map.of("text", agentContent + "\n\n"));
            } else if (agentThinking != null) {
                GraphSseHelper.emitEvent(state, SseEvents.AGENT_THINKING,
                    Map.of("text", agentThinking, "phaseId", phaseId));
            }
            GraphSseHelper.emitEvent(state, SseEvents.DELTA, Map.of("text", textStr));
            updates.put("generateResult", "textOutput");
            updates.put("pendingPatches", List.of());
            updates.put("modifiedFiles", List.of());
            return updates;
        }

        // Parse patches
        JsonNode patchesNode = root.get("patches");
        List<Patch> pendingPatches = new ArrayList<>();

        if (patchesNode != null && !patchesNode.isNull() && patchesNode.isArray()) {
            for (JsonNode patchNode : patchesNode) {
                try {
                    Patch patch = mapper.treeToValue(patchNode, Patch.class);
                    if (patch != null && patch.patches() != null && !patch.patches().isEmpty()) {
                        pendingPatches.add(patch);
                    }
                } catch (Exception e) {
                    log.warn("Failed to parse patch entry, skipping: {}", e.getMessage());
                }
            }
        }

        // Also try the LLM envelope format: toolCall / toolCalls
        if (pendingPatches.isEmpty()) {
            JsonNode toolCall = root.get("toolCall");
            if (toolCall != null && !toolCall.isNull()) {
                // Single toolCall — convert to a patch-like structure
                pendingPatches.add(convertToolCallToPatch(toolCall));
            }
        }

        if (!pendingPatches.isEmpty()) {
            // ★ Filter out invalid patches: path must be a real file path (not "unknown"/blank),
            // and at least one of newContent/search/replace must be non-empty.
            List<Patch> validPatches = new ArrayList<>();
            List<String> modifiedFiles = new ArrayList<>();
            for (Patch p : pendingPatches) {
                List<Patch.Edit> validEdits = new ArrayList<>();
                for (Patch.Edit edit : p.patches()) {
                    String path = edit.path();
                    boolean hasValidPath = path != null && !path.isBlank()
                            && !"unknown".equalsIgnoreCase(path);
                    boolean hasContent = (edit.newContent() != null && !edit.newContent().isBlank())
                            || (edit.search() != null && !edit.search().isBlank())
                            || (edit.replace() != null && !edit.replace().isBlank());
                    if (hasValidPath && hasContent) {
                        validEdits.add(edit);
                        modifiedFiles.add(path);
                    } else {
                        log.warn("GenerateAction: filtering out invalid patch edit: path={}, op={}, "
                            + "newContent.length={}, search.length={}, replace.length={}",
                            path, edit.op(),
                            edit.newContent() != null ? edit.newContent().length() : 0,
                            edit.search() != null ? edit.search().length() : 0,
                            edit.replace() != null ? edit.replace().length() : 0);
                    }
                }
                if (!validEdits.isEmpty()) {
                    validPatches.add(new Patch(p.summary(), p.rationale(), validEdits,
                            p.diffSummary(), p.rollback(), p.followUps()));
                }
            }

            if (validPatches.isEmpty()) {
                // All patches were invalid — treat as unstructured response
                log.warn("GenerateAction: all patches were invalid (path=unknown/blank or empty content). "
                    + "Treating as textOutput for phase={}", phaseId);
                return handleUnstructuredResponse(llmResponse, state, phaseId, updates);
            }

            updates.put("generateResult", "toolCalls");
            updates.put("pendingPatches", validPatches);
            updates.put("modifiedFiles", modifiedFiles);

            // ★ Interactive Agent: emit events based on whether agentContent is provided
            if (agentContent != null) {
                // When agentContent is provided (contains <plan>/<file> structured tags),
                // it already includes thinking reasoning and file information.
                // Only emit the structured content as delta — NO agent_thinking or agent_writing
                // to avoid duplicate display of the same information.
                GraphSseHelper.emitEvent(state, SseEvents.DELTA, Map.of("text", agentContent + "\n\n"));
            } else {
                // No agentContent — use agent_thinking + agent_writing for user-facing display
                if (agentThinking != null) {
                    GraphSseHelper.emitEvent(state, SseEvents.AGENT_THINKING,
                        Map.of("text", agentThinking, "phaseId", phaseId));
                }

                // Extract agentWriting from LLM output, fallback to rule-based generation
                JsonNode agentWritingNode = root.get("agentWriting");
                String agentWritingText = null;
                if (agentWritingNode != null && !agentWritingNode.isNull() && !agentWritingNode.asText("").isBlank()) {
                    agentWritingText = agentWritingNode.asText();
                }

                List<Map<String, Object>> writingFiles = new ArrayList<>();
                for (Patch p : validPatches) {
                    for (Patch.Edit edit : p.patches()) {
                        Map<String, Object> filePreview = new HashMap<>();
                        filePreview.put("path", edit.path());
                        filePreview.put("op", edit.op() != null ? edit.op().name().toLowerCase() : "write");
                        if (edit.newContent() != null) {
                            filePreview.put("lineCount", edit.newContent().split("\n").length);
                            // Preview: first 5 lines of new content
                            String[] lines = edit.newContent().split("\n");
                            String preview = String.join("\n", java.util.Arrays.copyOf(lines, Math.min(lines.length, 5)));
                            if (lines.length > 5) preview += "\n...";
                            filePreview.put("preview", preview);
                        }
                        writingFiles.add(filePreview);
                    }
                }
                if (!writingFiles.isEmpty()) {
                    String writingText = agentWritingText != null ? agentWritingText : buildWritingTextFallback(writingFiles);
                    GraphSseHelper.emitEvent(state, SseEvents.AGENT_WRITING,
                        Map.of("text", writingText, "files", writingFiles, "phaseId", phaseId));
                }
            }

            log.info("Generate phase={}: produced {} valid patches ({} filtered out), {} files",
                phaseId, validPatches.size(), pendingPatches.size() - validPatches.size(), modifiedFiles.size());
        } else {
            // No patches and no infoRequests — treat as unstructured response
            return handleUnstructuredResponse(llmResponse, state, phaseId, updates);
        }

        return updates;
    }

    private Map<String, Object> handleUnstructuredResponse(String llmResponse, OverAllState state,
                                                             String phaseId, Map<String, Object> updates) {
        // If LLM returned plain text (not structured patches), emit it as a delta SSE event
        // so the user at least sees the response
        if (llmResponse != null && !llmResponse.isBlank()) {
            GraphSseHelper.emitEvent(state, SseEvents.DELTA,
                    Map.of("text", llmResponse));
        }
        // B3 fix: use "textOutput" instead of "toolCalls" so the router skips
        // applyPatch/verify and goes directly to commit, avoiding wasted time
        // on empty patches flowing through the full pipeline
        updates.put("generateResult", "textOutput");
        updates.put("pendingPatches", List.of());
        updates.put("modifiedFiles", List.of());
        return updates;
    }

    @SuppressWarnings("unchecked")
    private Patch convertToolCallToPatch(JsonNode toolCallNode) {
        try {
            var args = toolCallNode.has("args") ? mapper.convertValue(toolCallNode.get("args"), Map.class) : Map.of();
            String path = (String) args.getOrDefault("path", "unknown");
            String op = (String) args.getOrDefault("op", "write");
            String newContent = (String) args.getOrDefault("newContent", "");
            String search = (String) args.getOrDefault("search", "");
            String replace = (String) args.getOrDefault("replace", "");

            Patch.Edit.Op editOp = switch (op.toLowerCase()) {
                case "create" -> Patch.Edit.Op.CREATE;
                case "replace" -> Patch.Edit.Op.REPLACE;
                case "delete" -> Patch.Edit.Op.DELETE;
                default -> Patch.Edit.Op.WRITE;
            };

            return new Patch(
                    "Generated patch",
                    List.of("auto-generated"),
                    List.of(new Patch.Edit(path, editOp, null, null, search, replace, newContent, null, null, null, null, null, null)),
                    null, null, null
            );
        } catch (Exception e) {
            log.warn("Failed to convert toolCall to Patch: {}", e.getMessage());
            return null;
        }
    }

    /**
     * Normalize infoRequests array: LLM may return string elements instead of
     * structured objects. Wrap each string element into a standard map.
     * Non-parseable elements are wrapped as kind="freeform-info" (a pseudo-gather kind)
     * rather than "askUser" to keep them in the gather flow.
     */
    private List<Map<String, Object>> normalizeInfoRequests(JsonNode infoRequestsNode) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (JsonNode element : infoRequestsNode) {
            if (element.isObject()) {
                try {
                    result.add(mapper.convertValue(element, new TypeReference<Map<String, Object>>() {}));
                } catch (Exception e) {
                    log.warn("Failed to parse infoRequest element, wrapping as freeform-info: {}", e.getMessage());
                    result.add(Map.of("id", UUID.randomUUID().toString(), "kind", "freeform-info",
                            "question", element.toString()));
                }
            } else {
                // Plain string — wrap into a freeform-info request (gather will handle as best-effort)
                result.add(Map.of("id", UUID.randomUUID().toString(), "kind", "freeform-info",
                        "question", element.asText()));
            }
        }
        return result;
    }

    private String extractJson(String response) {
        if (response == null) return "{}";
        String trimmed = response.trim();
        if (trimmed.startsWith("```")) {
            int start = trimmed.indexOf('\n') + 1;
            int end = trimmed.lastIndexOf("```");
            if (end > start) {
                return trimmed.substring(start, end).trim();
            }
        }
        int braceStart = trimmed.indexOf('{');
        int braceEnd = trimmed.lastIndexOf('}');
        if (braceStart >= 0 && braceEnd > braceStart) {
            return trimmed.substring(braceStart, braceEnd + 1);
        }
        return trimmed;
    }

    public String routeAfterGenerate(OverAllState state) {
        String result = (String) state.value("generateResult").orElse("toolCalls");
        boolean gatherExhausted = Boolean.TRUE.equals(state.value("gatherExhausted").orElse(false));
        int gatherCount = (int) state.value("gatherCount").orElse(0);

        // ★ Anti-loop: when gather has already been executed and the LLM still
        // outputs infoRequests, force the route to commit (textOutput path) instead
        // of going back to gather. This prevents the infinite
        // generate→gather→reenter→generate loop.
        // Hard limit: after 3 gathers, refuse to gather again.
        // Soft limit: after gatherExhausted, always refuse.
        if ("infoRequests".equals(result) && (gatherExhausted || gatherCount >= 3)) {
            log.warn("GenerateAction: LLM output infoRequests but gather budget exceeded "
                + "(gatherCount={}, gatherExhausted={}). Forcing to commit.", gatherCount, gatherExhausted);
            return "commit";
        }

        return switch (result) {
            case "infoRequests" -> "gather";
            case "askUser" -> "askUser";
            case "textOutput" -> "commit";  // B3 fix: skip applyPatch/verify for unstructured text
            default -> "applyPatch";
        };
    }

    // ── Interactive Agent helpers ──

    /**
     * Builds a prompt section describing available MCP tools.
     * Injected into the generate/planning prompt so the LLM knows it can use mcp.call.
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

    /**
     * Fallback method for generating agent_writing text when LLM does not provide agentWriting.
     * Uses rule-based formatting from the patch data.
     */
    private String buildWritingTextFallback(List<Map<String, Object>> files) {
        if (files.isEmpty()) return "准备修改文件";

        if (files.size() == 1) {
            var f = files.get(0);
            String path = String.valueOf(f.getOrDefault("path", "unknown"));
            String op = String.valueOf(f.getOrDefault("op", "write"));
            Object lineCount = f.get("lineCount");

            String fileName = path.contains("/") ? path.substring(path.lastIndexOf('/') + 1) : path;

            return switch (op) {
                case "create" -> "想要创建新文件: " + fileName + (lineCount != null ? " +" + lineCount + "行" : "");
                case "delete" -> "想要删除文件: " + fileName;
                default -> "想要修改文件: " + fileName + (lineCount != null ? " +" + lineCount + "行" : "");
            };
        }

        // Multiple files
        StringBuilder sb = new StringBuilder("想要修改以下文件:\n");
        for (var f : files) {
            String path = String.valueOf(f.getOrDefault("path", "unknown"));
            String op = String.valueOf(f.getOrDefault("op", "write"));
            Object lineCount = f.get("lineCount");
            String fileName = path.contains("/") ? path.substring(path.lastIndexOf('/') + 1) : path;
            sb.append("  ").append(fileName);
            if ("create".equals(op)) sb.append(" (新建)");
            if (lineCount != null) sb.append(" +").append(lineCount).append("行");
            sb.append("\n");
        }
        return sb.toString().trim();
    }
}
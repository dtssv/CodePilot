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

        // Find current phase details
        Map<String, Object> currentPhase = phases.stream()
                .filter(p -> phaseId.equals(p.get("id")))
                .findFirst()
                .orElse(Map.of());

        // ── Build generate prompt ──
        String generatePrompt = buildGeneratePrompt(input, phaseId, currentPhase, userPlan, gatheredInfo);

        // ── Call LLM ──
        String llmResponse;
        try {
            String modelId = (String) state.value("modelId").orElse(null);
            String modelSourceName = (String) state.value("modelSource").orElse(null);
            String userId = (String) state.value("userId").orElse(null);
            ModelSource modelSource = modelSourceName != null ? ModelSource.valueOf(modelSourceName) : null;
            log.info("GenerateAction resolving model: modelId={}, modelSource={}, userId={}", modelId, modelSourceName, userId);
            ChatClient chatClient = chatClientFactory.resolve(modelId, modelSource, userId).chatClient();
            llmResponse = chatClient.prompt()
                    .system(promptRegistry.get("agent.system"))
                    .user(generatePrompt)
                    .call()
                    .content();
        } catch (Exception e) {
            log.error("LLM generate call failed for phase={}", phaseId, e);
            updates.put("generateResult", "infoRequests");
            updates.put("infoRequests", List.of(Map.of(
                    "id", "gen-fallback-" + phaseId,
                    "kind", "askUser",
                    "question", "LLM call failed: " + e.getMessage()
            )));
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
                                        Map<String, Object> gatheredInfo) {
        String template = promptRegistry.get("graph.generate");
        String gatheredContext = gatheredInfo.isEmpty() ? ""
                : "[GATHERED CONTEXT]\n" + gatheredInfo.values().stream()
                        .map(info -> "- " + info.toString())
                        .reduce((a, b) -> a + "\n" + b).orElse("");
        return template
                .replace("{{input}}", input)
                .replace("{{phaseId}}", phaseId)
                .replace("{{phaseTitle}}", String.valueOf(currentPhase.getOrDefault("title", "")))
                .replace("{{phaseIntent}}", String.valueOf(currentPhase.getOrDefault("intent", "code-change")))
                .replace("{{gatheredContext}}", gatheredContext)
                .replace("{{userLocale}}", "zh-CN");
    }

    private Map<String, Object> parseGenerateResponse(String llmResponse, OverAllState state,
                                                       String phaseId, Map<String, Object> updates) throws Exception {
        String json = extractJson(llmResponse);
        JsonNode root = mapper.readTree(json);

        // Check for infoRequests — LLM may return string elements instead of objects
        JsonNode infoRequests = root.get("infoRequests");
        if (infoRequests != null && !infoRequests.isNull() && infoRequests.isArray() && !infoRequests.isEmpty()) {
            updates.put("generateResult", "infoRequests");
            updates.put("infoRequests", normalizeInfoRequests(infoRequests));
            return updates;
        }

        // Check for askUser — LLM may return a plain string instead of an object
        JsonNode askUser = root.get("askUser");
        if (askUser != null && !askUser.isNull()) {
            updates.put("generateResult", "askUser");
            if (askUser.isObject()) {
                updates.put("askUserQuestion", mapper.convertValue(askUser, Map.class));
            } else {
                // Wrap plain string into a structured askUser map
                updates.put("askUserQuestion", Map.of("question", askUser.asText()));
            }
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
            updates.put("generateResult", "toolCalls");
            updates.put("pendingPatches", pendingPatches);

            // Collect modified file paths for tracking
            List<String> modifiedFiles = new ArrayList<>();
            for (Patch p : pendingPatches) {
                for (Patch.Edit edit : p.patches()) {
                    if (edit.path() != null) {
                        modifiedFiles.add(edit.path());
                    }
                }
            }
            updates.put("modifiedFiles", modifiedFiles);

            log.info("Generate phase={}: produced {} patches, {} files", phaseId, pendingPatches.size(), modifiedFiles.size());
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
     */
    private List<Map<String, Object>> normalizeInfoRequests(JsonNode infoRequestsNode) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (JsonNode element : infoRequestsNode) {
            if (element.isObject()) {
                try {
                    result.add(mapper.convertValue(element, new TypeReference<Map<String, Object>>() {}));
                } catch (Exception e) {
                    log.warn("Failed to parse infoRequest element, wrapping as string: {}", e.getMessage());
                    result.add(Map.of("id", UUID.randomUUID().toString(), "kind", "askUser", "question", element.toString()));
                }
            } else {
                // Plain string — wrap into a structured request
                result.add(Map.of("id", UUID.randomUUID().toString(), "kind", "askUser", "question", element.asText()));
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
        return switch (result) {
            case "infoRequests" -> "gather";
            case "askUser" -> "askUser";
            case "textOutput" -> "commit";  // B3 fix: skip applyPatch/verify for unstructured text
            default -> "applyPatch";
        };
    }
}
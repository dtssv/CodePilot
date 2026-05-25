package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.dto.Patch;
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
import java.util.stream.Collectors;

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
    private final GraphSkillSupport graphSkillSupport;

    public GenerateAction(
            ChatClientFactory chatClientFactory,
            PromptRegistry promptRegistry,
            ObjectMapper mapper,
            GraphSkillSupport graphSkillSupport) {
        this.chatClientFactory = chatClientFactory;
        this.promptRegistry = promptRegistry;
        this.mapper = mapper;
        this.graphSkillSupport = graphSkillSupport;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "generate");
        if (Boolean.TRUE.equals(state.value("approachRepeatBlocked").orElse(false))) {
            updates.put("approachRepeatBlocked", false);
        }
        GraphExecutionLog.nodeEnter(state, "generate");

        updates.putAll(StuckStepRecovery.consumeStuckAnswerIfPresent(state));
        if ("failed".equals(updates.get("generateResult"))) {
            GraphExecutionLog.nodeExit(state, "generate", updates);
            return updates;
        }

        // ── Handle retry tool calls from repair ──
        // When repair produces direct tool calls (e.g., alternative shell command),
        // execute them directly without calling LLM again.
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> repairRetryCalls =
                (List<Map<String, Object>>) state.value("repairRetryToolCalls").orElse(List.of());
        if (!repairRetryCalls.isEmpty()) {
            log.info("GenerateAction: executing {} retry tool calls from repair", repairRetryCalls.size());
            updates.put("repairRetryToolCalls", List.of());  // consume — prevent re-execution

            // Convert retry calls to a JSON structure that GraphDirectToolExecutor can process
            var retryRoot = mapper.valueToTree(Map.of("toolCalls", repairRetryCalls));
            if (GraphDirectToolExecutor.executeFromJson(state, retryRoot, mapper, updates)) {
                if (maybeRouteToRepairAfterToolFailure(state, updates)) {
                    GraphExecutionLog.nodeExit(state, "generate", updates);
                    return updates;
                }
                updates.put("generateResult", "directTools");
                updates.put("pendingPatches", List.of());
            } else {
                // Retry calls were blocked/duplicate — route to repair for another attempt
                log.warn("GenerateAction: retry tool calls from repair were blocked, routing back to repair");
                updates.put("generateResult", "repair");
            }
            GraphExecutionLog.nodeExit(state, "generate", updates);
            return updates;
        }

        String input = (String) state.value("input").orElse("");
        String phaseId = (String) state.value("phaseCursor").orElse("");
        int failureRetries = (int) state.value("phaseFailureRetries").orElse(0);
        int generatePasses = (int) state.value("phaseGeneratePasses").orElse(0) + 1;
        updates.put("phaseGeneratePasses", generatePasses);
        if (ToolApproachTracker.isExhausted(state)
                && !Boolean.TRUE.equals(state.value("approachEscalationDone").orElse(false))) {
            log.warn("GenerateAction: tool approaches exhausted for phase {} — LLM user message", phaseId);
            var escalated = deliverApproachEscalation(state, updates, phaseId, input);
            GraphExecutionLog.nodeExit(state, "generate", escalated);
            return escalated;
        }
        if (StuckStepRecovery.shouldEscalateToAskUser(state)) {
            log.warn(
                    "GenerateAction: phase {} stuck after {} failure retries — escalating to askUser",
                    phaseId,
                    failureRetries);
            updates.put("generateResult", "askUser");
            updates.put("askUserQuestion", GraphUserMessages.stepStuckQuestion(phaseId));
            GraphExecutionLog.nodeExit(state, "generate", updates);
            return updates;
        }
        boolean conversationalOnly =
                Boolean.TRUE.equals(state.value("conversationalOnly").orElse(false));
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
        var skillActivation = graphSkillSupport.activate(state, GraphSkillNode.GENERATE, updates);
        String generatePrompt =
                (conversationalOnly
                                ? buildConversationalPrompt(input, projectMeta)
                                : buildGeneratePrompt(
                                        state,
                                        input,
                                        phaseId,
                                        currentPhase,
                                        userPlan,
                                        gatheredInfo,
                                        projectMeta,
                                        gatherCount,
                                        gatherExhausted,
                                        mcpTools))
                        + skillActivation.promptSection();

        GraphUiEmitter.transition(state, "generate");
        if (!conversationalOnly) {
            UserPlanProgressHelper.emitForCurrentPhase(state, "in_progress");
        }

        // ── Call LLM (marker-aware streaming) ──
        String llmResponse = "";
        try {
            String modelId = (String) state.value("modelId").orElse(null);
            String modelSourceName = (String) state.value("modelSource").orElse(null);
            String userId = (String) state.value("userId").orElse(null);
            ModelSource modelSource = modelSourceName != null ? ModelSource.valueOf(modelSourceName) : null;
            log.info("GenerateAction resolving model: modelId={}, modelSource={}, userId={}", modelId, modelSourceName, userId);
            var resolved = chatClientFactory.resolve(modelId, modelSource, userId);

            llmResponse =
                    GraphLlmHelper.streamUserPromptToSse(
                            resolved, state, generatePrompt, updates, !conversationalOnly);
        } catch (Exception e) {
            log.error("LLM generate call failed for phase={}", phaseId, e);
            if (GraphFailurePolicy.handleGenerateLlmFailure(state, updates, phaseId, e)) {
                GraphExecutionLog.nodeExit(state, "generate", updates);
                return updates;
            }
        }

        // ── Parse LLM response ──
        if (conversationalOnly) {
            var conv = handleUnstructuredResponse(
                    llmResponse,
                    state,
                    phaseId,
                    updates,
                    Boolean.TRUE.equals(updates.get("plainTextStreamed")));
            GraphExecutionLog.nodeExit(state, "generate", conv);
            return conv;
        }
        try {
            var parsed = parseGenerateResponse(llmResponse, state, phaseId, updates);
            GraphExecutionLog.nodeExit(state, "generate", parsed);
            return parsed;
        } catch (Exception e) {
            log.warn("Failed to parse LLM generate response for phase={}, treating as text output", phaseId, e);
            var unstructured = handleUnstructuredResponse(
                    llmResponse,
                    state,
                    phaseId,
                    updates,
                    Boolean.TRUE.equals(updates.get("plainTextStreamed")));
            GraphExecutionLog.nodeExit(state, "generate", unstructured);
            return unstructured;
        }
    }

    private String buildConversationalPrompt(String input, String projectMeta) {
        String template = promptRegistry.get("graph.conversational");
        String projectMetaSection =
                projectMeta.isBlank() ? "" : "[PROJECT CONTEXT]\n" + projectMeta + "\n";
        return template.replace("{{projectMeta}}", projectMetaSection).replace("{{input}}", input);
    }

    private String buildGeneratePrompt(
            OverAllState state,
            String input,
            String phaseId,
            Map<String, Object> currentPhase,
            Map<String, Object> userPlan,
            Map<String, Object> gatheredInfo,
            String projectMeta,
            int gatherCount,
            boolean gatherExhausted,
            List<Map<String, Object>> mcpTools) {
        int stepIndex = UserPlanProgressHelper.currentStepIndex(state);
        boolean planningProseStreamed =
                Boolean.TRUE.equals(state.value("planningProseStreamed").orElse(false));
        String template = promptRegistry.get("graph.generate");
        String gatheredContext = gatheredInfo.isEmpty() ? ""
                : "[GATHERED CONTEXT]\n" + GatheredInfoFormatter.format(gatheredInfo);
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
        String goalDirective = PhaseGoalHelper.stepAlreadySatisfiedDirective(state);
        if (!goalDirective.isBlank()) {
            antiLoopDirective += goalDirective;
        } else if (PhaseOutcomeHelper.rawToolsHadFailure(state)) {
            antiLoopDirective += PhaseOutcomeHelper.failureDirective();
        }
        String approachDirective = ToolApproachTracker.promptDirective(state);
        if (!approachDirective.isBlank()) {
            antiLoopDirective += approachDirective;
        }
        if (Boolean.TRUE.equals(state.value("approachRepeatBlocked").orElse(false))) {
            antiLoopDirective +=
                    "\n[MANDATORY] Your last toolCalls repeated an approach already listed above. "
                            + "Use a DIFFERENT tool, path, or query — do not resend the same fs.list/fs.read.\n";
        }
        antiLoopDirective += StuckStepRecovery.analyzeTextOutputDirective(state, gatheredInfo);
        String taskDirective =
                buildTaskDirective(state)
                        + CompileHintHelper.directive(projectMeta, input, state)
                        + GraphExecutionJournal.combinedContextDirective(state)
                        + buildMemoryDirective(state)
                        + io.codepilot.core.memory.ChangeLineageTracker.promptDirective(state);
        String proseBudget = "";
        if (planningProseStreamed || stepIndex > 0) {
            proseBudget =
                    "\n\n[PROSE BUDGET — STRICT]\n"
                            + "Do NOT restate the user's full request or multi-step plan essay.\n"
                            + "AGENT_CONTENT: at most 2 short sentences about what you will do in THIS step only.\n"
                            + "Prefer toolCalls over long prose when compile/run is needed.\n";
        }
        return template
                .replace("{{projectMeta}}", projectMetaSection)
                .replace("{{input}}", input)
                .replace("{{phaseId}}", phaseId)
                .replace("{{phaseTitle}}", String.valueOf(currentPhase.getOrDefault("title", "")))
                .replace("{{phaseIntent}}", String.valueOf(currentPhase.getOrDefault("intent", "code-change")))
                .replace("{{userPlanSteps}}", formatUserPlanOverview(userPlan))
                .replace(
                        "{{currentPlanStep}}",
                        formatCurrentPlanStep(state, userPlan, currentPhase, stepIndex))
                .replace("{{gatheredContext}}", gatheredContext)
                .replace("{{userLocale}}", "与用户输入语言一致")
                .replace("{{mcpTools}}", mcpToolsSection)
                + taskDirective
                + proseBudget
                + antiLoopDirective;
    }

    @SuppressWarnings("unchecked")
    private String buildTaskDirective(OverAllState state) {
        StringBuilder sb = new StringBuilder();
        List<Map<String, Object>> suggested =
                (List<Map<String, Object>>) state.value("intakeSuggestedTools").orElse(List.of());
        if (!suggested.isEmpty() && !Boolean.TRUE.equals(state.value("gatherExhausted").orElse(false))) {
            sb.append("\n\n[INTAKE TOOL PLAN — execute before answering]\n");
            sb.append(
                    "Intent classification determined these tools are needed (use infoRequests or toolCalls; "
                            + "exact names only):\n");
            for (Map<String, Object> t : suggested) {
                String name = String.valueOf(t.getOrDefault("name", ""));
                String why = String.valueOf(t.getOrDefault("why", ""));
                if (!name.isBlank()) {
                    sb.append("- ").append(name);
                    if (!why.isBlank() && !"null".equals(why)) {
                        sb.append(": ").append(why);
                    }
                    sb.append("\n");
                }
            }
            sb.append(
                    "NEVER fabricate tool output in prose. Run the tools, then answer from [GATHERED CONTEXT] or "
                            + "tool results.\n");
        }
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private String formatUserPlanOverview(Map<String, Object> userPlan) {
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> steps =
                (List<Map<String, Object>>) userPlan.getOrDefault("steps", List.of());
        if (steps.isEmpty()) {
            return "(无分步计划)";
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < steps.size(); i++) {
            Map<String, Object> step = steps.get(i);
            String title = String.valueOf(step.getOrDefault("title", "步骤 " + (i + 1)));
            String status = String.valueOf(step.getOrDefault("status", "pending"));
            sb.append(i + 1).append(". [").append(status).append("] ").append(title).append('\n');
        }
        return sb.toString().trim();
    }

    private String formatCurrentPlanStep(
            OverAllState state,
            Map<String, Object> userPlan,
            Map<String, Object> currentPhase,
            int stepIndex) {
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> steps =
                (List<Map<String, Object>>) userPlan.getOrDefault("steps", List.of());
        if (steps.isEmpty()) {
            return "按用户目标完成本阶段工作。";
        }
        int idx = Math.max(0, Math.min(stepIndex, steps.size() - 1));
        Map<String, Object> step = steps.get(idx);
        String title = String.valueOf(step.getOrDefault("title", "步骤 " + (idx + 1)));
        String desc = String.valueOf(step.getOrDefault("description", ""));
        Object phaseDesc = currentPhase.get("stepDescription");
        StringBuilder sb = new StringBuilder();
        sb.append("Step ").append(idx + 1).append("/").append(steps.size()).append(": ").append(title);
        if (!desc.isBlank() && !desc.equals(title)) {
            sb.append("\nDescription: ").append(desc);
        }
        if (phaseDesc != null && !phaseDesc.toString().isBlank() && !phaseDesc.toString().equals(desc)) {
            sb.append("\nPhase scope: ").append(phaseDesc);
        }
        String adapted = SessionExecutionFacts.resolvedStepAction(state);
        if (!adapted.isBlank()) {
            sb.append("\n\n[ADAPTED SCOPE — overrides stale plan wording]\n").append(adapted);
        }
        sb.append("\n\nImplement ONLY this step in patches[]. Do not implement later steps.");
        sb.append(
                "\nPlan wording (e.g. cmake) is a hint — satisfy the step goal with any working approach.");
        if (steps.size() > 1) {
            sb.append("\n\n[FORBIDDEN IN THIS PHASE — do NOT create or modify files for these steps yet]");
            for (int i = 0; i < steps.size(); i++) {
                if (i == idx) {
                    continue;
                }
                String otherTitle = String.valueOf(steps.get(i).getOrDefault("title", "步骤 " + (i + 1)));
                sb.append("\n- Step ").append(i + 1).append(": ").append(otherTitle);
            }
        }
        return sb.toString().trim();
    }

    /** Reject mistaken directory-as-file patches (any folder-like path with no real file content). */
    private boolean isValidPatchPath(String path, Patch.Edit edit) {
        if (path == null || path.isBlank() || "unknown".equalsIgnoreCase(path)) {
            return false;
        }
        String normalized = path.replace('\\', '/').trim();
        if (normalized.endsWith("/")) {
            return false;
        }
        boolean hasContent =
                (edit.newContent() != null && !edit.newContent().isBlank())
                        || (edit.search() != null && !edit.search().isBlank())
                        || (edit.replace() != null && !edit.replace().isBlank());
        if (!hasContent) {
            return false;
        }
        if (looksLikeDirectoryPath(normalized) && edit.newContent() != null) {
            String content = edit.newContent().trim();
            if (content.isEmpty()) {
                log.warn("GenerateAction: rejecting empty create for directory-like path: {}", path);
                return false;
            }
        }
        return true;
    }

    /** True when the final path segment has no extension (typical folder name, not a file). */
    private static boolean looksLikeDirectoryPath(String normalized) {
        int slash = normalized.lastIndexOf('/');
        String name = slash >= 0 ? normalized.substring(slash + 1) : normalized;
        return !name.isEmpty() && !name.contains(".");
    }

    private Map<String, Object> parseGenerateResponse(
            String llmResponse, OverAllState state, String phaseId, Map<String, Object> updates)
            throws Exception {
        boolean contentStreamed = Boolean.TRUE.equals(updates.get("agentContentStreamed"));
        boolean thinkingEmitted = Boolean.TRUE.equals(updates.get("agentThinkingEmitted"));

        String json = LlmJsonExtract.parseableJson(llmResponse);
        JsonNode root = mapper.readTree(json);

        JsonNode userPlanNode = root.get("userPlan");
        if (userPlanNode != null && !userPlanNode.isNull() && userPlanNode.isObject()) {
            @SuppressWarnings("unchecked")
            Map<String, Object> revised = mapper.convertValue(userPlanNode, Map.class);
            updates.put("userPlan", revised);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> revisedSteps =
                    (List<Map<String, Object>>) revised.getOrDefault("steps", List.of());
            if (revisedSteps.size() > 1) {
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> phases =
                        (List<Map<String, Object>>) state.value("phases").orElse(List.of());
                updates.put("phases", PhasePlanNormalizer.normalize(revisedSteps, phases));
            }
        }

        JsonNode agentThinkingNode = root.get("agentThinking");
        String agentThinking = null;
        if (agentThinkingNode != null && !agentThinkingNode.isNull() && !agentThinkingNode.asText("").isBlank()) {
            agentThinking = agentThinkingNode.asText();
        }

        JsonNode agentContentNode = root.get("agentContent");
        String agentContent = null;
        if (agentContentNode != null && !agentContentNode.isNull() && !agentContentNode.asText("").isBlank()) {
            agentContent = GraphContentSanitizer.stripFileToolPreviews(agentContentNode.asText());
        }

        if (GraphDirectToolExecutor.containsDirectToolCalls(root)) {
            if (GraphDirectToolExecutor.executeFromJson(state, root, mapper, updates)) {
                if (maybeRouteToRepairAfterToolFailure(state, updates)) {
                    GraphUiEmitter.contentIfPresent(state, agentContent, contentStreamed);
                    GraphUiEmitter.thinkingIfPresent(state, agentThinking, phaseId, thinkingEmitted);
                    return updates;
                }
                updates.put("generateResult", "directTools");
                updates.put("pendingPatches", List.of());
                GraphUiEmitter.contentIfPresent(state, agentContent, contentStreamed);
                GraphUiEmitter.thinkingIfPresent(state, agentThinking, phaseId, thinkingEmitted);
                return updates;
            }
            if (Boolean.TRUE.equals(updates.get("approachRepeatBlocked"))) {
                @SuppressWarnings("unchecked")
                Map<String, Object> gatheredAfterAbsorb =
                        (Map<String, Object>) updates.getOrDefault(
                                "gatheredInfo", state.value("gatheredInfo").orElse(Map.of()));
                if (updates.containsKey("gatheredInfo")
                        && PhaseGoalHelper.currentStepGoalSatisfied(state, gatheredAfterAbsorb)) {
                    log.info(
                            "GenerateAction: absorbed projectMeta root listing — step goal met");
                    updates.put("generateResult", "directTools");
                    updates.put("pendingPatches", List.of());
                    GraphUiEmitter.contentIfPresent(state, agentContent, contentStreamed);
                    GraphUiEmitter.thinkingIfPresent(state, agentThinking, phaseId, thinkingEmitted);
                    return updates;
                }
                if (PhaseGoalHelper.currentStepGoalSatisfied(state)) {
                    log.info(
                            "GenerateAction: duplicate toolCalls blocked but step goal already met — commit");
                    updates.put("generateResult", "textOutput");
                    GraphUiEmitter.contentIfPresent(state, agentContent, contentStreamed);
                    GraphUiEmitter.thinkingIfPresent(state, agentThinking, phaseId, thinkingEmitted);
                    return updates;
                }
                log.warn("GenerateAction: direct toolCalls blocked — duplicate approach");
                updates.put("generateResult", "retryGenerate");
                if (PhaseOutcomeHelper.rawToolsHadFailure(state)) {
                    updates.put(
                            "phaseFailureRetries",
                            (int) state.value("phaseFailureRetries").orElse(0) + 1);
                }
                GraphUiEmitter.contentIfPresent(state, agentContent, contentStreamed);
                GraphUiEmitter.thinkingIfPresent(state, agentThinking, phaseId, thinkingEmitted);
                return updates;
            }
        }

        // Check for infoRequests — LLM may return string elements instead of objects
        JsonNode infoRequests = root.get("infoRequests");
        if (infoRequests != null && !infoRequests.isNull() && infoRequests.isArray() && !infoRequests.isEmpty()) {
            updates.put("generateResult", "infoRequests");
            updates.put("infoRequests", normalizeInfoRequests(infoRequests));
            // ★ Emit agent_thinking with LLM-provided text, and store intent for GatherAction
            if (agentThinking != null) {
                updates.put("agentGatherIntent", agentThinking);
            }
            GraphUiEmitter.thinkingIfPresent(state, agentThinking, phaseId, thinkingEmitted);
            return updates;
        }

        // Check for askUser — LLM may return a plain string instead of an object
        JsonNode askUser = root.get("askUser");
        if (askUser != null && !askUser.isNull()) {
            Map<String, Object> question;
            if (askUser.isObject()) {
                @SuppressWarnings("unchecked")
                Map<String, Object> raw = mapper.convertValue(askUser, Map.class);
                question = AskUserPolicy.normalizeQuestionMap(raw);
            } else {
                question = AskUserPolicy.normalizeQuestionMap(
                        GraphUserMessages.defaultYesNoProceed(askUser.asText()));
            }
            if (question != null) {
                updates.put("generateResult", "askUser");
                updates.put("askUserQuestion", question);
                updates.put("askUserOrigin", "generate");
            }
            return updates;
        }

        // Check for textOutput — LLM explicitly chooses to respond with text instead of code changes
        // (e.g., when code already exists, or an explanation is more appropriate than patches)
        JsonNode textOutput = root.get("textOutput");
        if (textOutput != null && !textOutput.isNull() && !textOutput.asText("").isBlank()) {
            String textStr = textOutput.asText();
            @SuppressWarnings("unchecked")
            Map<String, Object> gatheredNow =
                    (Map<String, Object>) state.value("gatheredInfo").orElse(Map.of());
            PhaseGoalHelper.StepKind stepKind = PhaseGoalHelper.inferStepKind(state);
            String userInput = (String) state.value("input").orElse("");
            if (stepKind == PhaseGoalHelper.StepKind.RUN
                    && !PhaseGoalHelper.hasSuccessfulRun(gatheredNow)) {
                log.warn(
                        "GenerateAction: rejecting textOutput on RUN step — need shell.exec to run the binary");
                updates.put("generateResult", "directTools");
                updates.put(
                        "phaseFailureRetries", (int) state.value("phaseFailureRetries").orElse(0) + 1);
                return updates;
            }
            if (PhaseGoalHelper.sessionExpectsCompileRunWorkflow(state)
                    && stepKind == PhaseGoalHelper.StepKind.RUN
                    && !PhaseGoalHelper.overallCompileRunGoalMet(state)) {
                log.warn("GenerateAction: compile+run goal unmet — rejecting textOutput");
                updates.put("generateResult", "directTools");
                updates.put(
                        "phaseFailureRetries", (int) state.value("phaseFailureRetries").orElse(0) + 1);
                return updates;
            }
            if (stepKind == PhaseGoalHelper.StepKind.ANALYZE
                    || stepKind == PhaseGoalHelper.StepKind.SYNTHESIZE) {
                @SuppressWarnings("unchecked")
                Map<String, Object> gatheredForAnalyze =
                        (Map<String, Object>) state.value("gatheredInfo").orElse(Map.of());
                boolean hasReads =
                        PhaseGoalHelper.hasSuccessfulSourceRead(gatheredForAnalyze)
                                || PhaseGoalHelper.sessionHasSourceReads(state);
                int passes = (int) state.value("phaseGeneratePasses").orElse(0);
                // After 2+ generate passes with substantive text (≥80 chars), accept the
                // textOutput even without source reads — the code may already be in the
                // user's input context (IDE selection, pasted snippet) and doesn't require
                // an explicit fs.read/grep. Without this, ANALYZE steps loop endlessly
                // when the LLM provides analysis from context but has no gathered reads.
                boolean substantiveText = textStr.trim().length() >= 80;
                boolean acceptWithoutReads =
                        passes >= 2 && substantiveText && PhaseGoalHelper.inputHasEmbeddedSource(state);
                if ((!hasReads || !substantiveText)
                        && !acceptWithoutReads
                        && passes < 10
                        && stepKind != PhaseGoalHelper.StepKind.SYNTHESIZE) {
                    log.warn(
                            "GenerateAction: rejecting textOutput on {} step — need fs.read/grep of sources and substantive analysis (passes={})",
                            stepKind, passes);
                    updates.put("generateResult", "directTools");
                    updates.put(
                            "phaseFailureRetries",
                            (int) state.value("phaseFailureRetries").orElse(0) + 1);
                    return updates;
                }
                if (stepKind == PhaseGoalHelper.StepKind.SYNTHESIZE
                        && (!PhaseGoalHelper.sessionHasSourceReads(state)
                                || textStr.trim().length() < 80)
                        && passes < 10) {
                    log.warn(
                            "GenerateAction: rejecting textOutput on SYNTHESIZE — need prior source reads and substantive report");
                    updates.put("generateResult", "directTools");
                    updates.put(
                            "phaseFailureRetries",
                            (int) state.value("phaseFailureRetries").orElse(0) + 1);
                    return updates;
                }
                updates.put("phaseHasAnalysisOutput", true);
                if (!hasReads && acceptWithoutReads) {
                    updates.put("sessionHasSourceReads", true);
                }
            }
            log.info("GenerateAction: LLM returned textOutput for phase={}: {} chars", phaseId, textStr.length());
            GraphUiEmitter.contentIfPresent(state, agentContent, contentStreamed);
            GraphUiEmitter.thinkingIfPresent(state, agentThinking, phaseId, thinkingEmitted);
            if (!contentStreamed) {
                GraphSseHelper.emitEvent(
                        state,
                        SseEvents.DELTA,
                        Map.of("text", GraphContentSanitizer.stripForDisplay(textStr)));
            }
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
                    Patch patch = parsePatchEntry(patchNode);
                    if (patch != null && patch.patches() != null && !patch.patches().isEmpty()) {
                        pendingPatches.add(patch);
                    }
                } catch (Exception e) {
                    log.warn("Failed to parse patch entry, skipping: {}", e.getMessage());
                }
            }
        }

        JsonNode toolCallsNode = root.get("toolCalls");
        if (pendingPatches.isEmpty() && toolCallsNode != null && toolCallsNode.isArray()) {
            for (JsonNode tc : toolCallsNode) {
                try {
                    Patch patch = convertToolCallToPatch(tc);
                    if (patch.patches() != null && !patch.patches().isEmpty()) {
                        pendingPatches.add(patch);
                    }
                } catch (Exception e) {
                    log.warn("Failed to parse toolCalls entry, skipping: {}", e.getMessage());
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
                    if (!SessionExecutionFacts.allowWrittenFileOverwrite(state)
                            && SessionExecutionFacts.isFileWritten(state, path)) {
                        log.warn(
                                "GenerateAction: skipping patch to already-written file path={}",
                                path);
                        continue;
                    }
                    if (PhaseFailureRepairHelper.shouldPreferFixOverCreate(state, edit.op())) {
                        log.warn(
                                "GenerateAction: rejecting create patch on {} — fix existing files",
                                path);
                        continue;
                    }
                    if (isValidPatchPath(path, edit)) {
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
                if (SessionExecutionFacts.hasWrittenOutputs(state)) {
                    log.info(
                            "GenerateAction: patches skipped — output file(s) already written; commit");
                    if (!PhaseGoalHelper.currentStepGoalSatisfied(state)
                            && PhaseFailureRepairHelper.shouldRouteToRepair(state)) {
                        if (maybeRouteToRepairAfterToolFailure(state, updates)) {
                            return updates;
                        }
                    }
                    updates.put("generateResult", "textOutput");
                    updates.put("pendingPatches", List.of());
                    updates.put("modifiedFiles", List.of());
                    GraphUiEmitter.contentIfPresent(state, agentContent, contentStreamed);
                    GraphUiEmitter.thinkingIfPresent(state, agentThinking, phaseId, thinkingEmitted);
                    return updates;
                }
                log.warn(
                        "GenerateAction: all patches were invalid (path=unknown/blank or empty content). "
                                + "Treating as textOutput for phase={}",
                        phaseId);
                return handleUnstructuredResponse(llmResponse, state, phaseId, updates);
            }

            updates.put("generateResult", "toolCalls");
            // ★ Merge patches for the same file to reduce sub-patch count.
            // When the LLM generates multiple replace edits for the same file
            // (e.g. changing 17 function calls in leetcode42_test.cpp), sending
            // them as individual sub-patches causes poor UX (17 apply prompts)
            // and can lead to cascading search-match failures as earlier edits
            // change the file content. Merging them into a single full-file
            // replace avoids both problems.
            List<Patch> mergedPatches = mergeEditsForSameFile(validPatches);
            updates.put("pendingPatches", List.copyOf(mergedPatches));
            updates.put("modifiedFiles", List.copyOf(modifiedFiles));

            if (agentContent != null) {
                agentContent = GraphContentSanitizer.stripForDisplay(agentContent);
            }
            GraphUiEmitter.contentIfPresent(state, agentContent, contentStreamed);
            GraphUiEmitter.thinkingIfPresent(state, agentThinking, phaseId, thinkingEmitted);

            log.info("Generate phase={}: produced {} valid patches ({} filtered out), {} files",
                phaseId, validPatches.size(), pendingPatches.size() - validPatches.size(), modifiedFiles.size());
        } else {
            // No patches and no infoRequests — treat as unstructured response
            return handleUnstructuredResponse(llmResponse, state, phaseId, updates);
        }

        return updates;
    }

    private Map<String, Object> handleUnstructuredResponse(
            String llmResponse,
            OverAllState state,
            String phaseId,
            Map<String, Object> updates) {
        return handleUnstructuredResponse(
                llmResponse, state, phaseId, updates, false);
    }

    private Map<String, Object> handleUnstructuredResponse(
            String llmResponse,
            OverAllState state,
            String phaseId,
            Map<String, Object> updates,
            boolean alreadyStreamed) {
        String display = extractDisplayText(llmResponse);
        if (!alreadyStreamed && display != null && !display.isBlank()) {
            GraphSseHelper.emitEvent(state, SseEvents.DELTA, Map.of("text", display));
        }
        // B3 fix: use "textOutput" instead of "toolCalls" so the router skips
        // applyPatch/verify and goes directly to commit, avoiding wasted time
        // on empty patches flowing through the full pipeline
        updates.put("generateResult", "textOutput");
        updates.put("pendingPatches", List.of());
        updates.put("modifiedFiles", List.of());
        return updates;
    }

    /**
     * Merge multiple replace edits targeting the same file into a single Patch.
     *
     * <p>When the LLM generates many small replace edits for the same file (e.g. replacing
     * 17 function calls in a test file), sending them as individual sub-patches causes:
     * <ul>
     *   <li>Poor UX — 17 separate "apply this change?" prompts in the IDE</li>
     *   <li>Cascading search-match failures — earlier edits change the file content,
     *       making later search strings fail to match</li>
     * </ul>
     *
     * <p>This method detects when a Patch contains multiple replace edits for the same file
     * and merges them into a single full-file write edit, which the DiffManager can apply
     * atomically.
     *
     * @param patches the list of validated patches
     * @return a new list with same-file edits merged where applicable
     */
    private List<Patch> mergeEditsForSameFile(List<Patch> patches) {
        if (patches.size() != 1) {
            // Only merge when there's a single Patch with multiple edits for the same file.
            // Multi-patch scenarios (different summaries/rationales) are left as-is.
            return patches;
        }
        Patch p = patches.get(0);
        List<Patch.Edit> edits = p.patches();
        if (edits.size() <= 1) {
            return patches;
        }

        // Group edits by file path
        Map<String, List<Patch.Edit>> editsByFile = new java.util.LinkedHashMap<>();
        for (Patch.Edit edit : edits) {
            String path = edit.path() != null ? edit.path() : "unknown";
            editsByFile.computeIfAbsent(path, k -> new ArrayList<>()).add(edit);
        }

        // Only merge when all edits target the same file and are all replace ops
        if (editsByFile.size() != 1) {
            return patches;
        }
        String filePath = editsByFile.keySet().iterator().next();
        List<Patch.Edit> fileEdits = editsByFile.get(filePath);
        boolean allReplace = fileEdits.stream().allMatch(e -> e.op() == Patch.Edit.Op.REPLACE);
        if (!allReplace) {
            return patches;
        }

        // Check if any edit has newContent (full file replacement) — if so, keep as-is
        boolean hasFullContent = fileEdits.stream()
                .anyMatch(e -> e.newContent() != null && !e.newContent().isBlank());
        if (hasFullContent) {
            // An edit already has full file content; no merging needed
            return patches;
        }

        // Multiple replace edits for the same file with only search/replace pairs.
        // Log a warning — these should ideally be a single full-file write from the LLM.
        // For now, keep them as-is but log for observability. The DiffManager on the
        // plugin side handles sequential replaces, though with potential UX issues.
        log.info("GenerateAction: {} replace edits for same file {} — " +
                 "consider merging into a single write in the LLM prompt",
                 fileEdits.size(), filePath);
        return patches;
    }

    /** Prefer agentContent / textOutput from JSON envelopes over dumping raw JSON. */
    private Patch parsePatchEntry(JsonNode patchNode) throws com.fasterxml.jackson.core.JsonProcessingException {
        if (patchNode.has("path")) {
            Patch.Edit edit = mapper.treeToValue(patchNode, Patch.Edit.class);
            return new Patch(null, null, List.of(edit), null, null, null);
        }
        return mapper.treeToValue(patchNode, Patch.class);
    }

    private String extractDisplayText(String llmResponse) {
        if (llmResponse == null || llmResponse.isBlank()) {
            return null;
        }
        String stripped = GraphMarkerSanitizer.stripForDisplay(llmResponse).trim();
        if (!stripped.startsWith("{") && !stripped.startsWith("[")) {
            return stripped;
        }
        try {
            String json = LlmJsonExtract.parseableJson(llmResponse);
            JsonNode root = mapper.readTree(json);
            JsonNode agentContent = root.get("agentContent");
            if (agentContent != null && !agentContent.isNull() && !agentContent.asText("").isBlank()) {
                return GraphMarkerSanitizer.stripForDisplay(agentContent.asText());
            }
            JsonNode textOutput = root.get("textOutput");
            if (textOutput != null && !textOutput.isNull() && !textOutput.asText("").isBlank()) {
                return GraphMarkerSanitizer.stripForDisplay(textOutput.asText());
            }
        } catch (Exception ignored) {
            // fall through
        }
        return null;
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

    public String routeAfterGenerate(OverAllState state) {
        String result = (String) state.value("generateResult").orElse("toolCalls");
        boolean gatherExhausted = Boolean.TRUE.equals(state.value("gatherExhausted").orElse(false));
        int gatherCount = (int) state.value("gatherCount").orElse(0);
        int failureRetries = (int) state.value("phaseFailureRetries").orElse(0);
        boolean approachExhausted = ToolApproachTracker.isExhausted(state);
        boolean escalationDone =
                Boolean.TRUE.equals(state.value("approachEscalationDone").orElse(false));

        if ("askUser".equals(result)) {
            return "askUser";
        }

        if (approachExhausted) {
            if (!escalationDone) {
                return "reenter";
            }
            if ("textOutput".equals(result) || "failed".equals(result) || "askUser".equals(result)) {
                if (Boolean.TRUE.equals(state.value("overallGoalUnmet").orElse(false))) {
                    return "askUser";
                }
                return "summarize";
            }
        }

        if (escalationDone && Boolean.TRUE.equals(state.value("overallGoalUnmet").orElse(false))) {
            return "askUser";
        }

        // ★ Anti-loop: when gather has already been executed and the LLM still
        // outputs infoRequests, force the route to commit (textOutput path) instead
        // of going back to gather. This prevents the infinite
        // generate→gather→reenter→generate loop.
        // Hard limit: after 3 gathers, refuse to gather again.
        // Soft limit: after gatherExhausted, always refuse.
        if (PhaseGoalHelper.currentStepGoalSatisfied(state)) {
            log.info("GenerateAction: step goal satisfied — routing to commit");
            return "commit";
        }

        if ("infoRequests".equals(result) && approachExhausted) {
            if (escalationDone && Boolean.TRUE.equals(state.value("overallGoalUnmet").orElse(false))) {
                return "askUser";
            }
            return escalationDone ? "summarize" : "reenter";
        }

        if ("repair".equals(result)) {
            return "repair";
        }
        if ("abandonStep".equals(result)) {
            return "commit";
        }

        if ("infoRequests".equals(result) && (gatherExhausted || gatherCount >= 3)) {
            if (PhaseFailureRepairHelper.shouldRouteToRepair(state)) {
                if (PhaseFailureRepairHelper.shouldAbandonPhase(state)) {
                    return "commit";
                }
                return "repair";
            }
            PhaseGoalHelper.StepKind kind = PhaseGoalHelper.inferStepKind(state);
            if ((kind == PhaseGoalHelper.StepKind.ANALYZE
                    || kind == PhaseGoalHelper.StepKind.SYNTHESIZE
                    || kind == PhaseGoalHelper.StepKind.INSPECT
                    || kind == PhaseGoalHelper.StepKind.DISCOVER)
                    && !PhaseGoalHelper.currentStepGoalSatisfied(state)) {
                log.warn(
                        "GenerateAction: gather budget exceeded on {} step without deliverable — reenter",
                        kind);
                return "reenter";
            }
            log.warn("GenerateAction: LLM output infoRequests but gather budget exceeded "
                + "(gatherCount={}, gatherExhausted={}). Forcing to commit.", gatherCount, gatherExhausted);
            return "commit";
        }

        int generatePasses = (int) state.value("phaseGeneratePasses").orElse(0);
        if ("directTools".equals(result)) {
            if (approachExhausted) {
                if (escalationDone && Boolean.TRUE.equals(state.value("overallGoalUnmet").orElse(false))) {
                    return "askUser";
                }
                return escalationDone ? "summarize" : "reenter";
            }
            if (generatePasses >= 10) {
                return routeWhenGeneratePassesCapped(state, generatePasses, "directTools");
            }
            int rounds = (int) state.value("directToolRound").orElse(0);
            if (rounds < 3) {
                return "reenter";
            }
            if (PhaseFailureRepairHelper.shouldRouteToRepair(state)) {
                if (PhaseFailureRepairHelper.shouldAbandonPhase(state)) {
                    return "commit";
                }
                return "repair";
            }
            PhaseGoalHelper.StepKind kind = PhaseGoalHelper.inferStepKind(state);
            if ((kind == PhaseGoalHelper.StepKind.ANALYZE
                            || kind == PhaseGoalHelper.StepKind.SYNTHESIZE)
                    && !PhaseGoalHelper.currentStepGoalSatisfied(state)
                    && generatePasses < 10) {
                log.warn(
                        "GenerateAction: directToolRound cap on {} without deliverable — reenter",
                        kind);
                return "reenter";
            }
            log.warn("GenerateAction: directToolRound cap reached, forcing commit");
            return "commit";
        }

        if ("textOutput".equals(result)) {
            if (escalationDone) {
                if (Boolean.TRUE.equals(state.value("overallGoalUnmet").orElse(false))) {
                    return "askUser";
                }
                return "summarize";
            }
            PhaseGoalHelper.StepKind kind = PhaseGoalHelper.inferStepKind(state);
            if ((kind == PhaseGoalHelper.StepKind.ANALYZE
                    || kind == PhaseGoalHelper.StepKind.SYNTHESIZE
                    || kind == PhaseGoalHelper.StepKind.INSPECT
                    || kind == PhaseGoalHelper.StepKind.DISCOVER)
                    && !PhaseGoalHelper.currentStepGoalSatisfied(state)
                    && generatePasses < 10
                    // After 2+ passes, accept textOutput to avoid infinite reenter loops.
                    // The source code may already be in the user's input context (IDE selection,
                    // pasted snippet) without explicit fs.read/grep in gatheredInfo.
                    && generatePasses < 2
                    && !(kind == PhaseGoalHelper.StepKind.ANALYZE
                            && Boolean.TRUE.equals(
                                    state.value("phaseHasAnalysisOutput").orElse(false)))) {
                log.warn("GenerateAction: textOutput on {} but goal not met — reenter (passes={})", kind, generatePasses);
                return "reenter";
            }
            if (generatePasses >= 10) {
                return routeWhenGeneratePassesCapped(state, generatePasses, "textOutput");
            }
        }

        if ("textOutput".equals(result) && PhaseFailureRepairHelper.shouldRouteToRepair(state)) {
            if (PhaseFailureRepairHelper.shouldAbandonPhase(state)) {
                return "commit";
            }
            return "repair";
        }

        return switch (result) {
            case "infoRequests" -> "gather";
            case "askUser" -> "askUser";
            case "retryGenerate" -> "reenter";
            case "failed" -> "summarize";
            case "repair" -> "repair";
            case "textOutput" -> "commit";  // B3 fix: skip applyPatch/verify for unstructured text
            default -> "applyPatch";
        };
    }

    private static String routeWhenGeneratePassesCapped(
            OverAllState state, int generatePasses, String result) {
        log.warn(
                "GenerateAction: phaseGeneratePasses cap ({}) on {} — commit (repair/abandon via CommitAction)",
                generatePasses,
                result);
        return "commit";
    }

    /**
     * After failed direct tools, prefer repair over another generate loop. Returns true when updates
     * already contain a routing decision ({@code repair} or {@code abandonStep}).
     */
    private boolean maybeRouteToRepairAfterToolFailure(
            OverAllState state, Map<String, Object> updates) {
        if (!Boolean.TRUE.equals(updates.get("phaseToolsHadFailure"))) {
            @SuppressWarnings("unchecked")
            Map<String, Object> gathered =
                    (Map<String, Object>) updates.getOrDefault(
                            "gatheredInfo", state.value("gatheredInfo").orElse(Map.of()));
            if (!PhaseGoalHelper.currentStepGoalSatisfied(state, gathered)
                    && PhaseOutcomeHelper.gatheredHasFailures(gathered)
                    && PhaseFailureRepairHelper.shouldRouteToRepair(state)) {
                updates.put("phaseToolsHadFailure", true);
            } else {
                return false;
            }
        }
        if (!PhaseFailureRepairHelper.shouldRouteToRepair(state)) {
            return false;
        }
        if (PhaseFailureRepairHelper.shouldAbandonPhase(state)) {
            log.warn(
                    "GenerateAction: tool failures — abandoning phase after {} attempts",
                    PhaseFailureRepairHelper.failureAttempts(state));
            updates.put("generateResult", "abandonStep");
            updates.put("pendingPatches", List.of());
            return true;
        }
        log.warn(
                "GenerateAction: tool failures — routing to repair (attempt {}/{})",
                PhaseFailureRepairHelper.failureAttempts(state) + 1,
                PhaseFailureRepairHelper.MAX_PHASE_FAILURE_ATTEMPTS);
        PhaseFailureRepairHelper.prepareRepairFromFailures(state, updates);
        updates.put("generateResult", "repair");
        updates.put("pendingPatches", List.of());
        return true;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> deliverApproachEscalation(
            OverAllState state, Map<String, Object> updates, String phaseId, String input) {
        var phases = (List<Map<String, Object>>) state.value("phases").orElse(List.of());
        var userPlan = (Map<String, Object>) state.value("userPlan").orElse(Map.of());
        var gatheredInfo = (Map<String, Object>) state.value("gatheredInfo").orElse(Map.of());
        int stepIndex = UserPlanProgressHelper.currentStepIndex(state);
        Map<String, Object> currentPhase =
                phases.stream()
                        .filter(p -> phaseId.equals(p.get("id")))
                        .findFirst()
                        .orElse(Map.of());

        String template = promptRegistry.get("graph.approach-exhausted");
        String gatheredContext =
                gatheredInfo.isEmpty()
                        ? ""
                        : "[GATHERED CONTEXT]\n" + GatheredInfoFormatter.format(gatheredInfo);
        String prompt =
                template
                        .replace("{{input}}", input)
                        .replace(
                                "{{currentPlanStep}}",
                                formatCurrentPlanStep(state, userPlan, currentPhase, stepIndex))
                        .replace(
                                "{{triedApproaches}}",
                                ToolApproachTracker.formatHistoryForEscalation(state))
                        .replace("{{gatheredContext}}", gatheredContext)
                        .replace("{{userLocale}}", "与用户输入语言一致");

        GraphUiEmitter.transition(state, "generate");
        UserPlanProgressHelper.emitForCurrentPhase(state, "in_progress");

        String text = "";
        try {
            String modelId = (String) state.value("modelId").orElse(null);
            String modelSourceName = (String) state.value("modelSource").orElse(null);
            String userId = (String) state.value("userId").orElse(null);
            ModelSource modelSource =
                    modelSourceName != null ? ModelSource.valueOf(modelSourceName) : null;
            var resolved = chatClientFactory.resolve(modelId, modelSource, userId);
            text = GraphLlmHelper.streamUserPromptToSse(resolved, state, prompt, updates, false);
        } catch (Exception e) {
            log.error("Approach escalation LLM failed for phase={}", phaseId, e);
            if (GraphFailurePolicy.handleGenerateLlmFailure(state, updates, phaseId, e)) {
                return updates;
            }
        }

        String display = GraphContentSanitizer.stripForDisplay(text != null ? text.trim() : "");
        boolean alreadyStreamed = Boolean.TRUE.equals(updates.get("plainTextStreamed"));
        if (!display.isBlank() && !alreadyStreamed) {
            GraphSseHelper.emitEvent(state, SseEvents.DELTA, Map.of("text", display));
        }
        updates.put("generateResult", "askUser");
        updates.put("approachEscalationDone", true);
        updates.put("overallGoalUnmet", true);
        updates.put("askUserOrigin", "generate");
        updates.put("textOutput", display);
        if (!display.isBlank()) {
            updates.put(
                    "askUserQuestion",
                    Map.of("kind", "freeform", "text", display, "title", "需要您的确认以继续"));
        }
        return updates;
    }

    /**
     * Build memory context directive from activeMemories and memoryAnomalies.
     * Uses prompt templates graph.memoryLoad and graph.memoryConflict for
     * structured injection of memory context and anomaly resolution directives.
     */
    @SuppressWarnings("unchecked")
    private String buildMemoryDirective(OverAllState state) {
        StringBuilder sb = new StringBuilder();

        // ── Active memories (from all four layers, orchestrated by ContextOrchestrator) ──
        List<Map<String, Object>> activeMemories =
                (List<Map<String, Object>>) state.value("activeMemories").orElse(List.of());

        if (!activeMemories.isEmpty()) {
            // Inject the memory context rules template (graph.memoryLoad)
            sb.append("\n\n").append(promptRegistry.get("graph.memoryLoad")).append("\n");

            // Separate by layer for structured data injection
            List<Map<String, Object>> shortTerm = activeMemories.stream()
                    .filter(m -> "SHORT_TERM".equals(m.get("layer")))
                    .toList();
            List<Map<String, Object>> longTerm = activeMemories.stream()
                    .filter(m -> "LONG_TERM".equals(m.get("layer")))
                    .toList();

            // [SESSION CONTEXT] — short-term memory
            if (!shortTerm.isEmpty()) {
                sb.append("\n[SESSION CONTEXT — key facts from this session]\n");
                for (Map<String, Object> m : shortTerm) {
                    String summary = String.valueOf(m.getOrDefault("summary", ""));
                    String protection = String.valueOf(m.getOrDefault("protection", "DEGRADABLE"));
                    sb.append("- ").append(summary);
                    if ("IMMORTAL".equals(protection)) sb.append(" [IMMORTAL — never override]");
                    sb.append("\n");
                }
            }

            // [PROJECT MEMORY] — long-term memory
            if (!longTerm.isEmpty()) {
                sb.append("\n[PROJECT MEMORY — accumulated project knowledge]\n");
                for (Map<String, Object> m : longTerm) {
                    String summary = String.valueOf(m.getOrDefault("summary", ""));
                    String type = String.valueOf(m.getOrDefault("type", "FACT"));
                    sb.append("- [").append(type).append("] ").append(summary).append("\n");
                }
            }
        }

        // ── Memory anomalies — use graph.memoryConflict template for resolution directives ──
        List<String> anomalies =
                (List<String>) state.value("memoryAnomalies").orElse(List.of());
        if (!anomalies.isEmpty()) {
            String conflictTemplate = promptRegistry.get("graph.memoryConflict");
            String anomalyList = anomalies.stream()
                    .map(a -> "- " + a)
                    .collect(Collectors.joining("\n"));
            sb.append("\n\n").append(conflictTemplate.replace("{{anomalies}}", anomalyList));
        }

        // ── Memory compaction hint (if ContextOrchestrator indicated budget pressure) ──
        if (Boolean.TRUE.equals(state.value("memoryNeedsCompact").orElse(false))) {
            sb.append("\n\n").append(promptRegistry.get("graph.memoryCompact"));
        }

        return sb.toString();
    }

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

}
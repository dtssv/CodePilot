package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.dto.Patch;
import io.codepilot.core.graph.GraphExecutionJournal;
import io.codepilot.core.graph.GraphFailurePolicy;
import io.codepilot.core.graph.PhaseFailureRepairHelper;
import io.codepilot.core.graph.PhaseOutcomeHelper;
import io.codepilot.core.graph.GraphLlmHelper;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.graph.GraphUiEmitter;
import io.codepilot.core.graph.GraphUserMessages;
import io.codepilot.core.graph.LlmJsonExtract;
import io.codepilot.core.graph.skill.GraphSkillNode;
import io.codepilot.core.graph.skill.GraphSkillSupport;
import io.codepilot.core.graph.actions.VerifyAction.VerifyReport;
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
 * Repair node: LLM produces minimal fix patch based on VerifyReport.
 *
 * <p>Behavior:
 * <ol>
 *   <li>Read the VerifyReport from graph state to understand what failed</li>
 *   <li>Track attempt count per phase — if exhausted, escalate to AskUser</li>
 *   <li>Construct a repair prompt with the failure context (errors, diffs, diagnostics)</li>
 *   <li>Call the LLM to produce a minimal repair patch</li>
 *   <li>Convert repair patches to pendingPatches for ApplyPatch to execute</li>
 * </ol>
 */
@Component
public class RepairAction implements NodeAction {

    private static final Logger log = LoggerFactory.getLogger(RepairAction.class);
    private static final int DEFAULT_MAX_ATTEMPTS = 3;
    private static final int REPAIR_TOKEN_BUDGET = 2000;

    private final ChatClientFactory chatClientFactory;
    private final PromptRegistry promptRegistry;
    private final ObjectMapper mapper;
    private final GraphSkillSupport graphSkillSupport;

    public RepairAction(
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
        updates.put("currentNode", "repair");
        updates.put("allowWrittenFileOverwrite", true);

        String phaseId = (String) state.value("phaseCursor").orElse("");

        if (PhaseFailureRepairHelper.shouldAbandonPhase(state)) {
            log.warn(
                    "RepairAction: phase {} abandoned after {} failure attempts",
                    phaseId,
                    PhaseFailureRepairHelper.failureAttempts(state));
            PhaseFailureRepairHelper.clearPhaseAttemptCounters(updates);
            updates.put("overallGoalUnmet", true);
            updates.put("repairResult", "abandonStep");
            return updates;
        }

        if (state.value("verifyReport").isEmpty()
                && (PhaseOutcomeHelper.rawToolsHadFailure(state)
                        || PhaseOutcomeHelper.hasToolFailures(state))) {
            PhaseFailureRepairHelper.prepareRepairFromFailures(state, updates);
        }
        var repairPolicy = (Map<String, Object>) state.value("graphRepairPolicy").orElse(null);
        int maxAttempts = repairPolicy != null && repairPolicy.containsKey("maxAttempts")
                ? ((Number) repairPolicy.get("maxAttempts")).intValue()
                : DEFAULT_MAX_ATTEMPTS;

        // ── Track attempts — create a new copy to avoid ConcurrentModificationException
        // during state serialization/cloning by the graph framework
        var prevAttempts = (Map<String, Integer>) state.value("attempts").orElse(Map.of());
        var attempts = new HashMap<>(prevAttempts);
        int count = attempts.getOrDefault(phaseId, 0) + 1;
        attempts.put(phaseId, count);
        updates.put("attempts", Map.copyOf(attempts));

        // ── Check budget ──
        if (count >= maxAttempts) {
            log.warn("Repair budget exhausted for phase={}: attempts={}/{}", phaseId, count, maxAttempts);
            GraphSseHelper.emitEvent(state, SseEvents.GRAPH_BUDGET_ALERT,
                    Map.of("phaseId", phaseId, "kind", "attempts", "value", count, "limit", maxAttempts));

            // M3: Degradation strategy — check if any patches were partially applied
            var patchResults = (List<Map<String, Object>>) state.value("patchResults").orElse(List.of());
            long appliedCount = patchResults.stream()
                    .filter(r -> Boolean.TRUE.equals(r.get("success")))
                    .count();

            if (appliedCount > 0) {
                // Partial success: commit what succeeded, mark phase as partial
                log.info("Repair budget exhausted but {} patches were applied — committing partial results", appliedCount);
                updates.put("repairResult", "partialCommit");
                updates.put(
                        "askUserQuestion",
                        GraphUserMessages.repairBudgetQuestion(phaseId, count, true, appliedCount));
            } else {
                updates.put("repairResult", "askUser");
                updates.put(
                        "askUserQuestion",
                        GraphUserMessages.repairBudgetQuestion(phaseId, count, false, 0));
            }
            return updates;
        }

        // ── Build repair context ──
        var verifyReport = state.value("verifyReport").orElse(null);
        var originalCode = (String) state.value("phaseOriginalCode").orElse("");
        var appliedPatches = (List<Map<String, Object>>) state.value("appliedPatches").orElse(List.of());

        var skillActivation = graphSkillSupport.activate(state, GraphSkillNode.REPAIR, updates);
        String repairPrompt =
                buildRepairPrompt(state, verifyReport, originalCode, appliedPatches, phaseId)
                        + skillActivation.promptSection();

        GraphUiEmitter.transition(state, "repair");
        GraphSseHelper.emitEvent(state, SseEvents.GRAPH_REPAIR_PLAN,
                Map.of("phaseId", phaseId, "attempt", count, "strategy", "minimal-patch"));

        // ── Call LLM for repair (stream progress) ──
        String repairResponse = "";
        try {
            String modelId = (String) state.value("modelId").orElse(null);
            String modelSourceName = (String) state.value("modelSource").orElse(null);
            String userId = (String) state.value("userId").orElse(null);
            ModelSource modelSource = modelSourceName != null ? ModelSource.valueOf(modelSourceName) : null;
            log.info("RepairAction resolving model: modelId={}, modelSource={}, userId={}", modelId, modelSourceName, userId);
            ChatClient chatClient = chatClientFactory.resolve(modelId, modelSource, userId).chatClient();
            repairResponse =
                GraphLlmHelper.streamSystemUserToSse(
                    chatClient,
                    state,
                    promptRegistry.get("agent.system"),
                    repairPrompt,
                    updates);
        } catch (Exception e) {
            log.error("LLM repair call failed for phase={}", phaseId, e);
            if (GraphFailurePolicy.handleRepairLlmFailure(state, updates, phaseId, e)) {
                return updates;
            }
        }

        // ── Parse repair response ──
        List<Map<String, Object>> repairToolCalls = parseRepairResponse(repairResponse);
        updates.put("repairToolCalls", repairToolCalls);

        // ── Classify repair output: patches vs retry tool calls ──
        // The repair LLM may produce either:
        //   1. Code patches (fs.replace, op=create/replace/delete) → applyPatch path
        //   2. Retry tool calls (shell.exec, fs.read, fs.grep, etc.) → retryGenerate path
        //      These are direct tool calls that should be re-executed with different parameters,
        //      e.g., trying an alternative command, reading more lines, etc.
        List<Map<String, Object>> retryCalls = extractRetryToolCalls(repairToolCalls);
        List<Patch> repairPatches =
                convertRepairToolCallsToPatches(state, repairToolCalls, repairResponse);

        if (!repairPatches.isEmpty()) {
            // Path 1: LLM produced code patches — apply them
            updates.put("pendingPatches", repairPatches);
            updates.put("repairResult", "toolCalls");
            updates.put("repairRetryToolCalls", List.of());  // clear any stale retry calls
        } else if (!retryCalls.isEmpty()) {
            // Path 2: LLM produced retry tool calls (e.g., alternative shell command) —
            // route back to generate for execution
            log.info("Repair phase={}: LLM returned {} retry tool calls (no patches), routing to generate",
                    phaseId, retryCalls.size());
            updates.put("repairRetryToolCalls", retryCalls);
            updates.put("repairResult", "retryGenerate");
        } else {
            // Repair couldn't produce valid patches or retry calls — escalate to askUser
            log.warn("Repair phase={}: could not parse patches or retry calls from LLM response, escalating to askUser", phaseId);
            updates.put("repairResult", "askUser");
            updates.put(
                    "askUserQuestion",
                    GraphUserMessages.repairParseFailedQuestion(phaseId, count));
            updates.put("repairRetryToolCalls", List.of());
        }

        log.info("Repair phase={}: attempt={}/{}, responseLen={}, patchesProduced={}, retryCalls={}",
                phaseId, count, maxAttempts, repairResponse != null ? repairResponse.length() : 0,
                repairPatches.size(), retryCalls.size());

        GraphExecutionJournal.recordNodeOutcome(
                state,
                updates,
                "repair",
                (String) updates.getOrDefault("repairResult", "unknown"));

        return updates;
    }

    public String routeAfterRepair(OverAllState state) {
        String result = (String) state.value("repairResult").orElse("toolCalls");
        return switch (result) {
            case "askUser" -> "askUser";
            case "partialCommit", "abandonStep" -> "commit";
            case "retryRepair" -> "repair";
            case "retryGenerate" -> "generate";  // LLM produced retry tool calls → re-execute via generate
            case "failed" -> "finalize";
            default -> "applyPatch";  // "toolCalls" or any unknown → applyPatch
        };
    }

    // ─── Repair Prompt Construction ───────────────────────────────────

    private String buildRepairPrompt(
            OverAllState state,
            Object verifyReportObj,
            String originalCode,
            List<Map<String, Object>> appliedPatches,
            String phaseId) {

        StringBuilder sb = new StringBuilder();
        sb.append("[REPAIR TASK]\n");
        sb.append("Phase: ").append(phaseId).append("\n\n");

        @SuppressWarnings("unchecked")
        Map<String, Object> repairContext =
                (Map<String, Object>) state.value("repairContext").orElse(null);
        if (repairContext != null && !repairContext.isEmpty()) {
            sb.append(String.valueOf(repairContext.getOrDefault("directive", ""))).append('\n');
            String summary = String.valueOf(repairContext.getOrDefault("failureSummary", ""));
            if (!summary.isBlank()) {
                sb.append(summary).append("\n\n");
            }
            String stepLabel = String.valueOf(repairContext.getOrDefault("stepLabel", ""));
            if (!stepLabel.isBlank()) {
                sb.append("Step: ").append(stepLabel).append("\n");
            }
            Object attempt = repairContext.get("attempt");
            Object max = repairContext.get("maxAttempts");
            if (attempt != null && max != null) {
                sb.append("Repair attempt ").append(attempt).append("/").append(max).append("\n\n");
            }
        }

        sb.append("The previous step did not complete successfully. ");
        sb.append("Diagnose the failure and produce the appropriate repair (code patch or retry command) below.\n\n");

        sb.append("[VERIFICATION FAILURES]\n");
        if (verifyReportObj instanceof VerifyReport report) {
            if (!report.compileErrors.isEmpty()) {
                sb.append("Compile Errors:\n");
                for (var err : report.compileErrors) {
                    sb.append("  - ").append(err.file).append(":").append(err.line)
                            .append(" [").append(err.rule).append("] ").append(err.message).append("\n");
                }
            }
            if (!report.testFailures.isEmpty()) {
                sb.append("Test Failures:\n");
                for (var fail : report.testFailures) {
                    sb.append("  - ").append(fail.file).append(":").append(fail.line)
                            .append(" ").append(fail.message).append("\n");
                }
            }
            if (!report.lintWarnings.isEmpty()) {
                sb.append("Lint Warnings:\n");
                for (var warn : report.lintWarnings) {
                    sb.append("  - ").append(warn.file).append(":").append(warn.line)
                            .append(" [").append(warn.rule).append("] ").append(warn.message).append("\n");
                }
            }
        } else if (verifyReportObj instanceof Map<?, ?> reportMap) {
            appendMapFindings(sb, "Compile Errors", reportMap.get("compileErrors"));
            appendMapFindings(sb, "Test Failures", reportMap.get("testFailures"));
            appendMapFindings(sb, "Lint Warnings", reportMap.get("lintWarnings"));
        } else if (verifyReportObj != null) {
            sb.append(verifyReportObj.toString()).append("\n");
        }

        if (!appliedPatches.isEmpty()) {
            sb.append("\n[PREVIOUSLY APPLIED PATCHES]\n");
            for (var patch : appliedPatches) {
                sb.append("  File: ").append(patch.getOrDefault("path", "?")).append("\n");
                sb.append("  Op: ").append(patch.getOrDefault("op", "?")).append("\n");
            }
        }

        if (!originalCode.isEmpty()) {
            sb.append("\n[ORIGINAL CODE (before changes)]\n```\n").append(originalCode).append("\n```\n");
        }

        sb.append("\n[REPAIR RULES]\n");
        sb.append("1. Diagnose the root cause from the failure context above.\n");
        sb.append("2. Choose the appropriate repair strategy:\n");
        sb.append("   - If the failure is a CODE DEFECT (compile error, wrong logic, typo), produce a MINIMAL fs.replace patch.\n");
        sb.append("   - If the failure is a COMMAND EXECUTION ERROR (command not found, wrong path, missing tool), produce a shell.exec tool call with the corrected or alternative command.\n");
        sb.append("   - If the failure is INSUFFICIENT OUTPUT (e.g. build log too short, need more context), produce a shell.exec or fs.read tool call with adjusted parameters (e.g. more lines, different range).\n");
        sb.append("3. Prefer fs.replace on existing project files — do NOT use op=create for new test or helper files unless the step has no updatable target.\n");
        sb.append("4. If a build tool is missing (e.g. cmake), use an alternative shell command (e.g. g++) instead of creating more files.\n");
        sb.append("5. Preserve existing public APIs and method signatures.\n");
        sb.append("6. Add only necessary imports.\n");
        sb.append("7. Output as tool calls in the standard envelope format:\n");
        sb.append("   - For code fixes: {\"toolCall\": {\"name\": \"fs.replace\", \"args\": {\"path\": \"...\", \"search\": \"...\", \"replace\": \"...\"}}}\n");
        sb.append("   - For command retries: {\"toolCall\": {\"name\": \"shell.exec\", \"args\": {\"command\": \"...\"}}}\n");
        sb.append("   - For more data: {\"toolCall\": {\"name\": \"fs.read\", \"args\": {\"path\": \"...\", \"offset\": N, \"limit\": M}}}\n");
        sb.append("8. If you cannot produce a valid fix, the system will escalate to the user automatically.\n");
        sb.append(GraphExecutionJournal.combinedContextDirective(state));

        return sb.toString();
    }

    // ─── Response Parsing ─────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> parseRepairResponse(String response) {
        try {
            var node = mapper.readTree(response);
            if (node.has("toolCall")) {
                return List.of(mapper.convertValue(node.get("toolCall"), Map.class));
            }
            if (node.has("toolCalls")) {
                return mapper.convertValue(node.get("toolCalls"), List.class);
            }
        } catch (Exception ignored) {
            // Not JSON — treat as plain text repair suggestion
        }
        return List.of(Map.of(
            "type", "repair_note",
            "content", response != null ? response.substring(0, Math.min(response.length(), 500)) : ""
        ));
    }

    // ─── Extract Retry Tool Calls from Repair Response ─────────────

    /** Direct tools that can be re-executed via generate (not code patches). */
    private static final Set<String> RETRYABLE_TOOLS =
            Set.of("shell.exec", "fs.read", "fs.list", "fs.grep", "code.outline", "code.symbol", "code.usages");

    /**
     * Extracts tool calls from the repair response that are direct/executable tools
     * (shell.exec, fs.read, etc.) rather than code patches (fs.replace, op=create/delete).
     * These will be routed back to generate for re-execution.
     */
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> extractRetryToolCalls(List<Map<String, Object>> toolCalls) {
        List<Map<String, Object>> retryCalls = new ArrayList<>();
        for (Map<String, Object> tc : toolCalls) {
            if ("repair_note".equals(tc.get("type"))) {
                continue;
            }
            String name = (String) tc.getOrDefault("name", "");
            if (RETRYABLE_TOOLS.contains(name)) {
                retryCalls.add(tc);
            }
        }
        return retryCalls;
    }

    // ─── Convert Repair ToolCalls to Patches (B1 fix) ────────────────

    @SuppressWarnings("unchecked")
    private List<Patch> convertRepairToolCallsToPatches(
            OverAllState state, List<Map<String, Object>> toolCalls, String rawResponse) {
        List<Patch> patches = new ArrayList<>();
        for (Map<String, Object> tc : toolCalls) {
            if ("repair_note".equals(tc.get("type"))) {
                continue;
            }
            var args = (Map<String, Object>) tc.getOrDefault("args", tc);
            String path = (String) args.getOrDefault("path", "");
            String op = (String) args.getOrDefault("op", "replace");
            String newContent = (String) args.getOrDefault("newContent", "");
            String search = (String) args.getOrDefault("search", "");
            String replace = (String) args.getOrDefault("replace", "");

            if (path.isEmpty() && newContent.isEmpty()) {
                continue;
            }

            Patch.Edit.Op editOp = switch (op.toLowerCase()) {
                case "create" -> Patch.Edit.Op.CREATE;
                case "replace" -> Patch.Edit.Op.REPLACE;
                case "delete" -> Patch.Edit.Op.DELETE;
                default -> Patch.Edit.Op.WRITE;
            };
            if (PhaseFailureRepairHelper.shouldPreferFixOverCreate(state, editOp)) {
                log.warn("RepairAction: rejecting create patch path={} — fix existing files", path);
                continue;
            }

            patches.add(new Patch(
                "Repair patch",
                List.of("repair"),
                List.of(new Patch.Edit(path, editOp, null, null, search, replace, newContent, null, null, null, null, null, null)),
                null, null, null
            ));
        }

        // Fallback: try JSON envelope format (patches[])
        if (patches.isEmpty() && rawResponse != null) {
            try {
                var node = mapper.readTree(LlmJsonExtract.parseableJson(rawResponse));
                if (node.has("patches")) {
                    var patchesNode = node.get("patches");
                    if (patchesNode.isArray()) {
                        for (var patchNode : patchesNode) {
                            Patch patch = mapper.treeToValue(patchNode, Patch.class);
                            if (patch != null && patch.patches() != null && !patch.patches().isEmpty()) {
                                patches.add(patch);
                            }
                        }
                    }
                }
            } catch (Exception e) {
                log.debug("Could not extract patches from repair response JSON", e);
            }
        }

        return patches;
    }

    private String extractJson(String response) {
        if (response == null) return "{}";
        String trimmed = response.trim();
        if (trimmed.startsWith("```")) {
            int start = trimmed.indexOf('\n') + 1;
            int end = trimmed.lastIndexOf("```");
            if (end > start) return trimmed.substring(start, end).trim();
        }
        int braceStart = trimmed.indexOf('{');
        int braceEnd = trimmed.lastIndexOf('}');
        if (braceStart >= 0 && braceEnd > braceStart) return trimmed.substring(braceStart, braceEnd + 1);
        return trimmed;
    }

    // ─── Utilities ────────────────────────────────────────────────────

    private String summarizeFailures(Object verifyReportObj) {
        if (verifyReportObj instanceof VerifyReport report) {
            StringBuilder sb = new StringBuilder();
            if (!report.compileErrors.isEmpty()) {
                sb.append(report.compileErrors.size()).append(" compile error(s)");
            }
            if (!report.testFailures.isEmpty()) {
                if (!sb.isEmpty()) sb.append(", ");
                sb.append(report.testFailures.size()).append(" test failure(s)");
            }
            if (!report.lintWarnings.isEmpty()) {
                if (!sb.isEmpty()) sb.append(", ");
                sb.append(report.lintWarnings.size()).append(" lint warning(s)");
            }
            return sb.toString();
        }
        return "Unknown verification failure";
    }

    private void appendMapFindings(StringBuilder sb, String label, Object findingsObj) {
        if (findingsObj instanceof List<?> list && !list.isEmpty()) {
            sb.append(label).append(":\n");
            for (var item : list) {
                if (item instanceof Map<?, ?> m) {
                    sb.append("  - ").append(Objects.toString(m.get("file"), "?")).append(":")
                            .append(Objects.toString(m.get("line"), "0"))
                            .append(" [").append(Objects.toString(m.get("rule"), "")).append("] ")
                            .append(Objects.toString(m.get("message"), "")).append("\n");
                }
            }
        }
    }
}
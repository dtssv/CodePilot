package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.graph.actions.VerifyAction.VerifyReport;
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
 *   <li>Emit the repair result as toolCalls for the client to apply</li>
 * </ol>
 *
 * <p>The repair prompt explicitly instructs the model to:
 * <ul>
 *   <li>Produce the MINIMAL change to fix the issue</li>
 *   <li>Not refactor unrelated code</li>
 *   <li>Preserve existing public APIs</li>
 *   <li>Add only necessary imports</li>
 * </ul>
 */
@Component
public class RepairAction implements NodeAction {

    private static final Logger log = LoggerFactory.getLogger(RepairAction.class);
    private static final int DEFAULT_MAX_ATTEMPTS = 3;
    private static final int REPAIR_TOKEN_BUDGET = 2000;

    private final ChatClient chatClient;
    private final PromptRegistry promptRegistry;
    private final ObjectMapper mapper;

    public RepairAction(ChatClient chatClient, PromptRegistry promptRegistry, ObjectMapper mapper) {
        this.chatClient = chatClient;
        this.promptRegistry = promptRegistry;
        this.mapper = mapper;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "repair");

        String phaseId = (String) state.value("phaseCursor").orElse("");
        var repairPolicy = (Map<String, Object>) state.value("graphRepairPolicy").orElse(null);
        int maxAttempts = repairPolicy != null && repairPolicy.containsKey("maxAttempts")
                ? ((Number) repairPolicy.get("maxAttempts")).intValue()
                : DEFAULT_MAX_ATTEMPTS;

        // ── Track attempts ──
        var attempts = (Map<String, Integer>) state.value("attempts").orElse(new HashMap<>());
        int count = attempts.getOrDefault(phaseId, 0) + 1;
        attempts.put(phaseId, count);
        updates.put("attempts", attempts);

        // ── Check budget ──
        if (count >= maxAttempts) {
            log.warn("Repair budget exhausted for phase={}: attempts={}/{}", phaseId, count, maxAttempts);
            GraphSseHelper.emitEvent(state, SseEvents.GRAPH_BUDGET_ALERT,
                    Map.of("phaseId", phaseId, "kind", "attempts", "value", count, "limit", maxAttempts));

            // Build an AskUser request with the failure context
            var verifyReport = state.value("verifyReport").orElse(null);
            String failureSummary = summarizeFailures(verifyReport);
            updates.put("repairResult", "askUser");
            updates.put("askUserQuestion", Map.of(
                "title", "Auto-repair failed after " + count + " attempts",
                "reason", "The agent could not fix the following issues automatically",
                "blocking", true,
                "failureSummary", failureSummary,
                "suggestedActions", List.of(
                    "Manually fix the errors and continue",
                    "Revert the changes and replan",
                    "Adjust the repair strategy"
                )
            ));
            return updates;
        }

        // ── Build repair context ──
        var verifyReport = state.value("verifyReport").orElse(null);
        var originalCode = (String) state.value("phaseOriginalCode").orElse("");
        var appliedPatches = (List<Map<String, Object>>) state.value("appliedPatches").orElse(List.of());

        String repairPrompt = buildRepairPrompt(verifyReport, originalCode, appliedPatches, phaseId);

        // ── Call LLM for repair ──
        String repairResponse;
        try {
            repairResponse = chatClient.prompt()
                    .system(promptRegistry.get("agent.system"))
                    .user(repairPrompt)
                    .call()
                    .content();
        } catch (Exception e) {
            log.error("LLM repair call failed for phase={}", phaseId, e);
            updates.put("repairResult", "askUser");
            updates.put("askUserQuestion", Map.of(
                "title", "Repair LLM call failed",
                "reason", "Exception: " + e.getMessage(),
                "blocking", true
            ));
            return updates;
        }

        // ── Parse repair response ──
        // The LLM should output toolCalls (fs.replace patches) for the client to apply
        updates.put("repairResult", "toolCalls");
        updates.put("repairToolCalls", parseRepairResponse(repairResponse));

        // Emit repair progress
        GraphSseHelper.emitEvent(state, SseEvents.GRAPH_REPAIR_PLAN,
                Map.of("phaseId", phaseId, "attempt", count, "strategy", "minimal-patch"));

        log.info("Repair phase={}: attempt={}/{}, responseLen={}",
                phaseId, count, maxAttempts, repairResponse != null ? repairResponse.length() : 0);

        return updates;
    }

    public String routeAfterRepair(OverAllState state) {
        String result = (String) state.value("repairResult").orElse("toolCalls");
        return switch (result) {
            case "infoRequests" -> "gather";
            case "askUser" -> "askUser";
            default -> "applyPatch";
        };
    }

    // ─── Repair Prompt Construction ───────────────────────────────────

    private String buildRepairPrompt(
            Object verifyReportObj,
            String originalCode,
            List<Map<String, Object>> appliedPatches,
            String phaseId) {

        StringBuilder sb = new StringBuilder();
        sb.append("[REPAIR TASK]\n");
        sb.append("Phase: ").append(phaseId).append("\n\n");

        sb.append("The previous code change did not pass verification. ");
        sb.append("Produce the MINIMAL patch to fix the issues below.\n\n");

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
        sb.append("1. Produce the MINIMAL change to fix the issue. Do NOT refactor unrelated code.\n");
        sb.append("2. Preserve existing public APIs and method signatures.\n");
        sb.append("3. Add only necessary imports.\n");
        sb.append("4. Output as fs.replace tool calls in the standard envelope format.\n");
        sb.append("5. If the fix requires more than 3 separate edits, output infoRequests instead.\n");

        return sb.toString();
    }

    // ─── Response Parsing ─────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> parseRepairResponse(String response) {
        // Attempt to extract toolCalls from the LLM response
        // The response may be in envelope format (JSON) or plain text with patches
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
        // Fallback: wrap the entire response as a single repair note
        return List.of(Map.of(
            "type", "repair_note",
            "content", response != null ? response.substring(0, Math.min(response.length(), 500)) : ""
        ));
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
}
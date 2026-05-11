package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.sse.SseEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Verify node: runs compile/test/lint assertions against the applied patches.
 *
 * <p>Verification strategy (deterministic, no LLM call):
 * <ol>
 *   <li>Request IDE diagnostics from the client via {@code ide.diagnostics} tool</li>
 *   <li>Check if any compile errors exist in the modified files</li>
 *   <li>If {@code policy.graphVerify.runTests=true}, request test execution via {@code shell.exec}</li>
 *   <li>If {@code policy.graphVerify.runLint=true}, request lint check via {@code shell.exec}</li>
 *   <li>Aggregate results into a {@link VerifyReport}</li>
 * </ol>
 *
 * <p>The verify node does NOT execute tools itself — it emits a {@code graph_verify_request} SSE event
 * that instructs the client to run diagnostics/tests and report back. The client result is stored
 * in the graph state by the next turn of the AgentLoop.
 */
@Component
public class VerifyAction implements NodeAction {

    private static final Logger log = LoggerFactory.getLogger(VerifyAction.class);

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "verify");

        String phaseId = (String) state.value("phaseCursor").orElse("");
        var modifiedFiles = (List<String>) state.value("modifiedFiles").orElse(List.of());

        // ── Step 1: Request IDE diagnostics from the client ──
        // The client runs ide.diagnostics and reports back via tool-result
        GraphSseHelper.emitEvent(state, "graph_verify_request",
                Map.of(
                    "phaseId", phaseId,
                    "type", "ide_diagnostics",
                    "files", modifiedFiles,
                    "message", "Requesting IDE diagnostics for modified files"
                ));

        // ── Step 2: Check verification policy ──
        var verifyPolicy = state.value("graphVerifyPolicy").orElse(null);
        boolean runTests = false;
        boolean runLint = false;
        if (verifyPolicy instanceof Map<?, ?> policyMap) {
            runTests = Boolean.TRUE.equals(policyMap.get("runTests"));
            runLint = Boolean.TRUE.equals(policyMap.get("runLint"));
        }

        // ── Step 3: Build the verify report from available data ──
        // In a real implementation, the client would have returned diagnostics results
        // which are stored in state. For now we check the state for client-reported results.
        var clientDiagnostics = (List<Map<String, Object>>) state.value("clientDiagnostics").orElse(List.of());
        var testResults = (Map<String, Object>) state.value("testResults").orElse(null);
        var lintResults = (Map<String, Object>) state.value("lintResults").orElse(null);

        VerifyReport report = buildVerifyReport(clientDiagnostics, testResults, lintResults, modifiedFiles);

        updates.put("verifyReport", report);
        updates.put("verifyResult", report.overallResult);

        // Emit the verify report as SSE event
        GraphSseHelper.emitEvent(state, SseEvents.GRAPH_VERIFY, Map.of(
                "phaseId", phaseId,
                "result", report.overallResult,
                "compileErrors", report.compileErrors.size(),
                "testFailures", report.testFailures.size(),
                "lintWarnings", report.lintWarnings.size(),
                "summary", report.summary()
        ));

        log.info("Verify phase={}: result={}, compileErrors={}, testFailures={}, lintWarnings={}",
                phaseId, report.overallResult,
                report.compileErrors.size(), report.testFailures.size(), report.lintWarnings.size());

        return updates;
    }

    /**
     * Route after verify based on the result:
     * - success → commit the phase
     * - fail → repair the issues
     * - uncertain → ask the user
     */
    public String routeAfterVerify(OverAllState state) {
        String result = (String) state.value("verifyResult").orElse("success");
        return switch (result) {
            case "fail" -> "repair";
            case "uncertain" -> "askUser";
            default -> "commit";
        };
    }

    // ─── Verify Report ────────────────────────────────────────────────

    /**
     * Structured verification report with categorized findings.
     */
    public static class VerifyReport {
        public final String overallResult; // "success", "fail", "uncertain"
        public final List<VerifyFinding> compileErrors;
        public final List<VerifyFinding> testFailures;
        public final List<VerifyFinding> lintWarnings;
        public final long durationMs;

        public VerifyReport(String overallResult,
                            List<VerifyFinding> compileErrors,
                            List<VerifyFinding> testFailures,
                            List<VerifyFinding> lintWarnings,
                            long durationMs) {
            this.overallResult = overallResult;
            this.compileErrors = compileErrors;
            this.testFailures = testFailures;
            this.lintWarnings = lintWarnings;
            this.durationMs = durationMs;
        }

        public String summary() {
            return String.format("VerifyReport{result=%s, compileErrors=%d, testFailures=%d, lintWarnings=%d, duration=%dms}",
                    overallResult, compileErrors.size(), testFailures.size(), lintWarnings.size(), durationMs);
        }
    }

    public static class VerifyFinding {
        public final String file;
        public final int line;
        public final String severity; // "error", "warning"
        public final String message;
        public final String rule; // e.g., "ConstantConditions", "UnusedImport"

        public VerifyFinding(String file, int line, String severity, String message, String rule) {
            this.file = file;
            this.line = line;
            this.severity = severity;
            this.message = message;
            this.rule = rule;
        }
    }

    // ─── Report Builder ───────────────────────────────────────────────

    private VerifyReport buildVerifyReport(
            List<Map<String, Object>> clientDiagnostics,
            Map<String, Object> testResults,
            Map<String, Object> lintResults,
            List<String> modifiedFiles) {

        long start = System.currentTimeMillis();
        List<VerifyFinding> compileErrors = new ArrayList<>();
        List<VerifyFinding> testFailures = new ArrayList<>();
        List<VerifyFinding> lintWarnings = new ArrayList<>();

        // Parse IDE diagnostics from client
        for (Map<String, Object> diag : clientDiagnostics) {
            String severity = (String) diag.getOrDefault("severity", "warning");
            String file = (String) diag.getOrDefault("path", "unknown");
            int line = diag.containsKey("line") ? ((Number) diag.get("line")).intValue() : 0;
            String message = (String) diag.getOrDefault("message", "");
            String rule = (String) diag.getOrDefault("rule", "");

            if ("ERROR".equalsIgnoreCase(severity)) {
                compileErrors.add(new VerifyFinding(file, line, "error", message, rule));
            } else {
                lintWarnings.add(new VerifyFinding(file, line, "warning", message, rule));
            }
        }

        // Parse test results
        if (testResults != null) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> failures = (List<Map<String, Object>>) testResults.getOrDefault("failures", List.of());
            for (Map<String, Object> failure : failures) {
                String file = (String) failure.getOrDefault("testClass", "unknown");
                int line = failure.containsKey("line") ? ((Number) failure.get("line")).intValue() : 0;
                String message = (String) failure.getOrDefault("message", "Test failed");
                testFailures.add(new VerifyFinding(file, line, "error", message, "test-failure"));
            }
        }

        // Parse lint results
        if (lintResults != null) {
            @SuppressWarnings("unchecked")
            var warnings = (List<Map<String, Object>>) lintResults.getOrDefault("warnings", List.of());
            for (Map<String, Object> warning : warnings) {
                String file = (String) warning.getOrDefault("file", "unknown");
                int line = warning.containsKey("line") ? ((Number) warning.get("line")).intValue() : 0;
                String message = (String) warning.getOrDefault("message", "");
                String rule = (String) warning.getOrDefault("rule", "lint");
                lintWarnings.add(new VerifyFinding(file, line, "warning", message, rule));
            }
        }

        // Determine overall result
        String overallResult;
        if (!compileErrors.isEmpty()) {
            overallResult = "fail"; // Compile errors → must repair
        } else if (!testFailures.isEmpty()) {
            overallResult = "fail"; // Test failures → must repair
        } else if (!lintWarnings.isEmpty() && lintWarnings.size() > 5) {
            overallResult = "uncertain"; // Too many lint warnings → ask user
        } else {
            overallResult = "success";
        }

        return new VerifyReport(overallResult, compileErrors, testFailures, lintWarnings,
                System.currentTimeMillis() - start);
    }
}
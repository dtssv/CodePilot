package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.conversation.ToolResultBus;
import io.codepilot.core.conversation.ToolResultBus.ToolResultEvent;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.sse.SseEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.*;

/**
 * Verify node: runs compile/test/lint assertions against the applied patches.
 *
 * <p>Verification strategy (deterministic, no LLM call):
 * <ol>
 *   <li>Emit a {@code tool_call} SSE for {@code ide.diagnostics} to request IDE diagnostics</li>
 *   <li>Await the client's result via {@link ToolResultBus} (Redis Pub/Sub)</li>
 *   <li>Parse diagnostics and aggregate into a {@link VerifyReport}</li>
 *   <li>If {@code policy.graphVerify.runTests=true}, also request test execution</li>
 * </ol>
 */
@Component
public class VerifyAction implements NodeAction {

    private static final Logger log = LoggerFactory.getLogger(VerifyAction.class);

    private static final Duration DIAGNOSTICS_TIMEOUT = Duration.ofSeconds(30);

    private final ToolResultBus toolResultBus;

    public VerifyAction(ToolResultBus toolResultBus) {
        this.toolResultBus = toolResultBus;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "verify");

        String sessionId = (String) state.value("sessionId").orElse("");
        String phaseId = (String) state.value("phaseCursor").orElse("");
        var modifiedFiles = (List<String>) state.value("modifiedFiles").orElse(List.of());

        // ── Step 1: Request IDE diagnostics from the client ──
        // Emit a tool_call SSE so the client runs ide.diagnostics and reports back
        String diagToolCallId = UUID.randomUUID().toString();
        // Register future BEFORE emitting SSE to avoid race condition
        var diagFuture = ToolResultBus.registerFuture(sessionId, diagToolCallId);
        GraphSseHelper.emitEvent(state, SseEvents.TOOL_CALL, Map.of(
            "id", diagToolCallId,
            "name", "ide.diagnostics",
            "args", Map.of("files", modifiedFiles)
        ));

        // Also emit the legacy event for backward compatibility
        GraphSseHelper.emitEvent(state, "graph_verify_request",
                Map.of(
                    "phaseId", phaseId,
                    "type", "ide_diagnostics",
                    "files", modifiedFiles,
                    "message", "Requesting IDE diagnostics for modified files"
                ));

        // ── Step 2: Await client diagnostics via ToolResultBus ──
        List<Map<String, Object>> clientDiagnostics = new ArrayList<>();
        try {
            ToolResultEvent result = diagFuture.get(DIAGNOSTICS_TIMEOUT.toMillis(), java.util.concurrent.TimeUnit.MILLISECONDS);

            if (result != null && result.ok() && result.result() != null) {
                // Parse diagnostics from client result
                clientDiagnostics = parseDiagnosticsResult(result.result());
                log.info("Verify phase={}: received {} diagnostics from client", phaseId, clientDiagnostics.size());
            } else {
                String error = result != null ? result.errorMessage() : "Timeout waiting for diagnostics";
                log.warn("Verify phase={}: diagnostics request failed: {}", phaseId, error);
            }
        } catch (Exception e) {
            ToolResultBus.unregisterFuture(sessionId, diagToolCallId);
            log.warn("Verify phase={}: diagnostics request timed out or failed: {}", phaseId, e.getMessage());
        }

        // ── Step 3: Check verification policy for additional checks ──
        var verifyPolicy = state.value("graphVerifyPolicy").orElse(null);
        boolean runTests = false;
        boolean runLint = false;
        if (verifyPolicy instanceof Map<?, ?> policyMap) {
            runTests = Boolean.TRUE.equals(policyMap.get("runTests"));
            runLint = Boolean.TRUE.equals(policyMap.get("runLint"));
        }

        Map<String, Object> testResults = null;
        Map<String, Object> lintResults = null;

        // ── Step 3a: Run tests if policy requires ──
        if (runTests) {
            String testToolCallId = UUID.randomUUID().toString();
            var testFuture = ToolResultBus.registerFuture(sessionId, testToolCallId);
            GraphSseHelper.emitEvent(state, SseEvents.TOOL_CALL, Map.of(
                "id", testToolCallId,
                "name", "shell.exec",
                "args", Map.of("command", "test", "files", modifiedFiles)
            ));
            try {
                ToolResultEvent testResult = testFuture.get(60, java.util.concurrent.TimeUnit.SECONDS);
                if (testResult != null && testResult.ok() && testResult.result() instanceof Map) {
                    testResults = (Map<String, Object>) testResult.result();
                }
            } catch (Exception e) {
                log.warn("Verify phase={}: test execution failed: {}", phaseId, e.getMessage());
            }
        }

        // ── Step 3b: Run lint if policy requires ──
        if (runLint) {
            String lintToolCallId = UUID.randomUUID().toString();
            var lintFuture = ToolResultBus.registerFuture(sessionId, lintToolCallId);
            GraphSseHelper.emitEvent(state, SseEvents.TOOL_CALL, Map.of(
                "id", lintToolCallId,
                "name", "shell.exec",
                "args", Map.of("command", "lint", "files", modifiedFiles)
            ));
            try {
                ToolResultEvent lintResult = lintFuture.get(30, java.util.concurrent.TimeUnit.SECONDS);
                if (lintResult != null && lintResult.ok() && lintResult.result() instanceof Map) {
                    lintResults = (Map<String, Object>) lintResult.result();
                }
            } catch (Exception e) {
                log.warn("Verify phase={}: lint check failed: {}", phaseId, e.getMessage());
            }
        }

        // ── Step 4: Build verify report from collected results ──
        VerifyReport report = buildVerifyReport(clientDiagnostics, testResults, lintResults, modifiedFiles);

        updates.put("clientDiagnostics", clientDiagnostics);
        updates.put("verifyReport", report.toMap());
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
     * Parses the client diagnostics result into a list of diagnostic maps.
     * Handles both list and map result formats.
     */
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> parseDiagnosticsResult(Object result) {
        if (result instanceof List<?> list) {
            List<Map<String, Object>> diagnostics = new ArrayList<>();
            for (Object item : list) {
                if (item instanceof Map<?, ?> map) {
                    diagnostics.add((Map<String, Object>) map);
                }
            }
            return diagnostics;
        }
        if (result instanceof Map<?, ?> map) {
            // Single diagnostic or wrapped result
            var diagnostics = (List<?>) map.get("diagnostics");
            if (diagnostics != null) {
                List<Map<String, Object>> result2 = new ArrayList<>();
                for (Object item : diagnostics) {
                    if (item instanceof Map<?, ?> m) {
                        result2.add((Map<String, Object>) m);
                    }
                }
                return result2;
            }
            return List.of((Map<String, Object>) map);
        }
        return List.of();
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

        public Map<String, Object> toMap() {
            return Map.of(
                "overallResult", overallResult,
                "compileErrors", compileErrors.stream().map(VerifyFinding::toMap).toList(),
                "testFailures", testFailures.stream().map(VerifyFinding::toMap).toList(),
                "lintWarnings", lintWarnings.stream().map(VerifyFinding::toMap).toList(),
                "durationMs", durationMs
            );
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

        public Map<String, Object> toMap() {
            return Map.of("file", file, "line", line, "severity", severity, "message", message, "rule", rule);
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
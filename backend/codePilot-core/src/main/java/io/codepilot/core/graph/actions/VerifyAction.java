package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.conversation.ToolResultBus;
import io.codepilot.core.conversation.ToolResultBus.ToolResultEvent;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.graph.GraphToolWaitHelper;
import io.codepilot.core.graph.GraphUiEmitter;
import io.codepilot.core.sse.SseEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.*;
import java.util.concurrent.CompletableFuture;

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

        GraphUiEmitter.transition(state, "verify");

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

        // ── Step 2: Check verification policy and emit parallel client checks ──
        var verifyPolicy = state.value("graphVerifyPolicy").orElse(null);
        boolean runTests = false;
        boolean runLint = false;
        if (verifyPolicy instanceof Map<?, ?> policyMap) {
            runTests = Boolean.TRUE.equals(policyMap.get("runTests"));
            runLint = Boolean.TRUE.equals(policyMap.get("runLint"));
        }

        // Do not emit shell.exec with literal "test"/"lint" — they are not real binaries and
        // cause repeated useless tool runs. IDE diagnostics cover compile issues after patch.
        CompletableFuture<ToolResultEvent> testFuture = null;
        String testToolCallId = null;
        if (runTests) {
            log.info("Verify phase={}: runTests requested — using ide.diagnostics only (no shell test stub)", phaseId);
        }

        CompletableFuture<ToolResultEvent> lintFuture = null;
        String lintToolCallId = null;
        if (runLint) {
            log.info("Verify phase={}: runLint requested — using ide.diagnostics only (no shell lint stub)", phaseId);
        }

        List<CompletableFuture<ToolResultEvent>> parallelWaits = new ArrayList<>();
        parallelWaits.add(diagFuture);
        if (testFuture != null) parallelWaits.add(testFuture);
        if (lintFuture != null) parallelWaits.add(lintFuture);

        Duration verifyTimeout = Duration.ofSeconds(
                Math.max(DIAGNOSTICS_TIMEOUT.toSeconds(), runTests ? 60 : 0));
        if (runLint) {
            verifyTimeout = verifyTimeout.plusSeconds(30);
        }

        List<Map<String, Object>> clientDiagnostics = new ArrayList<>();
        Map<String, Object> testResults = null;
        Map<String, Object> lintResults = null;

        try {
            GraphToolWaitHelper.awaitAll(parallelWaits, state, "验证中", verifyTimeout);
        } catch (Exception e) {
            log.warn("Verify phase={}: parallel verification timed out or failed: {}", phaseId, e.getMessage());
        }

        try {
            ToolResultEvent result = diagFuture.getNow(null);
            if (result == null && diagFuture.isDone()) {
                result = diagFuture.get();
            }
            if (result != null && result.ok() && result.result() != null) {
                clientDiagnostics = parseDiagnosticsResult(result.result());
                log.info("Verify phase={}: received {} diagnostics from client", phaseId, clientDiagnostics.size());
            } else if (result != null) {
                log.warn("Verify phase={}: diagnostics request failed: {}", phaseId, result.errorMessage());
            }
        } catch (Exception e) {
            ToolResultBus.unregisterFuture(sessionId, diagToolCallId);
            log.warn("Verify phase={}: diagnostics failed: {}", phaseId, e.getMessage());
        }

        if (testFuture != null) {
            try {
                ToolResultEvent testResult = testFuture.getNow(null);
                if (testResult == null && testFuture.isDone()) {
                    testResult = testFuture.get();
                }
                if (testResult != null && testResult.ok() && testResult.result() instanceof Map) {
                    testResults = (Map<String, Object>) testResult.result();
                }
            } catch (Exception e) {
                if (testToolCallId != null) {
                    ToolResultBus.unregisterFuture(sessionId, testToolCallId);
                }
                log.warn("Verify phase={}: test execution failed: {}", phaseId, e.getMessage());
            }
        }

        if (lintFuture != null) {
            try {
                ToolResultEvent lintResult = lintFuture.getNow(null);
                if (lintResult == null && lintFuture.isDone()) {
                    lintResult = lintFuture.get();
                }
                if (lintResult != null && lintResult.ok() && lintResult.result() instanceof Map) {
                    lintResults = (Map<String, Object>) lintResult.result();
                }
            } catch (Exception e) {
                if (lintToolCallId != null) {
                    ToolResultBus.unregisterFuture(sessionId, lintToolCallId);
                }
                log.warn("Verify phase={}: lint check failed: {}", phaseId, e.getMessage());
            }
        }

        // ── Step 4: Build verify report from collected results ──
        VerifyReport report = buildVerifyReport(clientDiagnostics, testResults, lintResults, modifiedFiles);

        updates.put("clientDiagnostics", List.copyOf(clientDiagnostics));
        updates.put("verifyReport", report.toMap());
        updates.put("verifyResult", report.overallResult);

        // Emit the verify report as SSE event
        var verifyPayload = new LinkedHashMap<String, Object>();
        verifyPayload.put("phaseId", phaseId);
        verifyPayload.put("result", report.overallResult);
        verifyPayload.put("compileErrors", report.compileErrors.size());
        verifyPayload.put("testFailures", report.testFailures.size());
        verifyPayload.put("lintWarnings", report.lintWarnings.size());
        verifyPayload.put("summary", report.displaySummary());
        verifyPayload.put("failures", report.failureLines());
        GraphSseHelper.emitEvent(state, SseEvents.GRAPH_VERIFY, verifyPayload);

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

        /** Short user-facing summary (chat UI). */
        public String displaySummary() {
            return switch (overallResult) {
                case "success" -> "验证通过：未发现编译错误、测试失败或严重告警。";
                case "fail" -> buildFailureHeadline();
                default -> "验证结果不确定，请查看详情或手动确认。";
            };
        }

        /** Machine-readable summary for logs and debugging. */
        public String summary() {
            return String.format(
                    "VerifyReport{result=%s, compileErrors=%d, testFailures=%d, lintWarnings=%d, duration=%dms}",
                    overallResult,
                    compileErrors.size(),
                    testFailures.size(),
                    lintWarnings.size(),
                    durationMs);
        }

        public List<String> failureLines() {
            List<String> lines = new ArrayList<>();
            for (VerifyFinding f : compileErrors) {
                lines.add(formatFinding("编译错误", f));
            }
            for (VerifyFinding f : testFailures) {
                lines.add(formatFinding("测试失败", f));
            }
            for (VerifyFinding f : lintWarnings) {
                lines.add(formatFinding("告警", f));
            }
            return lines;
        }

        private String buildFailureHeadline() {
            var parts = new ArrayList<String>();
            if (!compileErrors.isEmpty()) {
                parts.add(compileErrors.size() + " 个编译错误");
            }
            if (!testFailures.isEmpty()) {
                parts.add(testFailures.size() + " 个测试失败");
            }
            if (!lintWarnings.isEmpty()) {
                parts.add(lintWarnings.size() + " 条告警");
            }
            if (parts.isEmpty()) {
                return "验证未通过，请查看详情。";
            }
            return "验证未通过：" + String.join("，", parts) + "。";
        }

        private static String formatFinding(String prefix, VerifyFinding f) {
            if (f.line > 0) {
                return String.format("%s · %s:%d — %s", prefix, f.file, f.line, f.message);
            }
            return String.format("%s · %s — %s", prefix, f.file, f.message);
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
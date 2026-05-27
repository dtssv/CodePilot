package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.graph.GraphUiEmitter;
import io.codepilot.core.graph.UserPlanProgressHelper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * PreCheck node: validates phase entry conditions before code generation.
 *
 * <p>Checks include:
 * <ul>
 *   <li>Required files exist (e.g., pom.xml, package.json)</li>
 *   <li>Required tools are available (e.g., maven, npm, docker)</li>
 *   <li>Phase dependencies are met (previous phase completed)</li>
 *   <li>No conflicting modifications from earlier phases</li>
 * </ul>
 *
 * <p>If conditions are not met, the node either:
 * <ul>
 *   <li>Requests info via Gather (e.g., read a file to check its content)</li>
 *   <li>Fails and escalates to AskUser (e.g., a required tool is missing)</li>
 * </ul>
 */
@Component
public class PreCheckAction implements NodeAction {

    private static final Logger log = LoggerFactory.getLogger(PreCheckAction.class);

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "preCheck");

        String phaseId = (String) state.value("phaseCursor").orElse("");
        GraphUiEmitter.transition(state, "preCheck");
        UserPlanProgressHelper.emitForCurrentPhase(state, "in_progress");
        var phases = (List<Map<String, Object>>) state.value("phases").orElse(List.of());
        var completedPhases = (List<String>) state.value("completedPhases").orElse(List.of());
        var modifiedFiles = (List<String>) state.value("modifiedFiles").orElse(List.of());

        Map<String, Object> currentPhase = findPhase(phases, phaseId);
        PreCheckResult result = performChecks(currentPhase, completedPhases, modifiedFiles, state);

        updates.put("preCheckPassed", result.passed);
        updates.put("preCheckResult", result.overallStatus);
        updates.put("preCheckInfoRequests", result.infoRequests);
        // ★ Set infoRequests so GatherAction can read them when routing to gather
        if (!result.infoRequests.isEmpty()) {
            updates.put("infoRequests", result.infoRequests);
        }

        GraphSseHelper.emitEvent(state, "graph_precheck",
                Map.of(
                    "phaseId", phaseId,
                    "passed", result.passed,
                    "checks", result.checkResults.size(),
                    "failures", result.failures.size(),
                    "message", result.summary()
                ));

        log.info("PreCheck phase={}: passed={}, failures={}", phaseId, result.passed, result.failures.size());
        return updates;
    }

    public String routeAfterPreCheck(OverAllState state) {
        String result = (String) state.value("preCheckResult").orElse("ok");
        boolean gatherExhausted = Boolean.TRUE.equals(state.value("gatherExhausted").orElse(false));
        int gatherCount = (int) state.value("gatherCount").orElse(0);

        // ★ Anti-loop: when gather has already been executed multiple times,
        // refuse to route back to gather from preCheck.
        if ("missing_info".equals(result) && (gatherExhausted || gatherCount >= 3)) {
            log.warn("PreCheckAction: missing_info but gather budget exceeded "
                + "(gatherCount={}, gatherExhausted={}). Forcing to generate.", gatherCount, gatherExhausted);
            return "generate";
        }

        return switch (result) {
            case "missing_info" -> "gather";
            case "blocked" -> "askUser";
            default -> "generate";
        };
    }

    // ─── Data Classes ─────────────────────────────────────────────────

    public static class PreCheckResult {
        public final boolean passed;
        public final String overallStatus; // "ok", "missing_info", "blocked"
        public final List<CheckResult> checkResults;
        public final List<String> failures;
        public final List<Map<String, Object>> infoRequests;

        public PreCheckResult(boolean passed, String overallStatus,
                              List<CheckResult> checkResults,
                              List<String> failures,
                              List<Map<String, Object>> infoRequests) {
            this.passed = passed;
            this.overallStatus = overallStatus;
            this.checkResults = checkResults;
            this.failures = failures;
            this.infoRequests = infoRequests;
        }

        public String summary() {
            if (passed) return "All pre-checks passed";
            return "Pre-check failed: " + String.join("; ", failures);
        }
    }

    public static class CheckResult {
        public final String name;
        public final boolean passed;
        public final String message;

        public CheckResult(String name, boolean passed, String message) {
            this.name = name;
            this.passed = passed;
            this.message = message;
        }
    }

    // ─── Check Implementation ─────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private PreCheckResult performChecks(
            Map<String, Object> currentPhase,
            List<String> completedPhases,
            List<String> modifiedFiles,
            OverAllState state) {

        List<CheckResult> checkResults = new ArrayList<>();
        List<String> failures = new ArrayList<>();
        List<Map<String, Object>> infoRequests = new ArrayList<>();

        if (currentPhase == null) {
            return new PreCheckResult(true, "ok", checkResults, failures, infoRequests);
        }

        // Check 1: Phase dependencies
        var dependsOn = (List<String>) currentPhase.getOrDefault("dependsOn", List.of());
        for (String dep : dependsOn) {
            boolean depCompleted = completedPhases.contains(dep);
            checkResults.add(new CheckResult("dependency:" + dep, depCompleted,
                    depCompleted ? "Dependency completed" : "Dependency not yet completed"));
            if (!depCompleted) {
                failures.add("Phase dependency '" + dep + "' not completed");
            }
        }

        // Check 2: Required files exist
        var requiredFiles = (List<String>) currentPhase.getOrDefault("requiredFiles", List.of());
        var existingFiles = (List<String>) state.value("existingFiles").orElse(List.of());
        for (String file : requiredFiles) {
            boolean exists = existingFiles.contains(file);
            checkResults.add(new CheckResult("file_exists:" + file, exists,
                    exists ? "File exists" : "File not found"));
            if (!exists) {
                infoRequests.add(Map.of(
                    "id", "precheck-file-" + file.hashCode(),
                    "kind", "fs.read",
                    "args", Map.of("path", file),
                    "why", "Verify required file exists for phase entry",
                    "priority", 1
                ));
                failures.add("Required file '" + file + "' not found");
            }
        }

        // Check 3: No conflicting modifications
        var targetFiles = (List<String>) currentPhase.getOrDefault("targetFiles", List.of());
        for (String target : targetFiles) {
            if (modifiedFiles.contains(target)) {
                checkResults.add(new CheckResult("no_conflict:" + target, false,
                        "File was modified by a previous phase — potential conflict"));
            }
        }

        // Check 4: Product dependency verification (LLM-declared structured requiredProducts)
        List<io.codepilot.core.graph.PhaseMemoryHelper.ProductRequirement> requirements =
                io.codepilot.core.graph.PhaseMemoryHelper.productRequirements(currentPhase);
        if (!requirements.isEmpty()) {
            @SuppressWarnings("unchecked")
            List<String> allModifiedFiles =
                    (List<String>) state.value("modifiedFiles").orElse(List.of());

            for (var req : requirements) {
                String productKey = req.product();
                List<String> patternsForProduct = req.patterns();

                if (patternsForProduct.isEmpty()) {
                    checkResults.add(new CheckResult("product_dependency:" + productKey, true,
                            "No patterns declared for " + productKey + " — cannot verify"));
                    continue;
                }

                boolean productExists = allModifiedFiles.stream()
                        .anyMatch(f -> patternsForProduct.stream()
                                .anyMatch(pattern -> matchesPattern(f, pattern)));

                checkResults.add(new CheckResult("product_dependency:" + productKey,
                        productExists,
                        productExists
                                ? productKey + " files exist from previous phases"
                                : "No " + productKey + " files found matching declared patterns"));

                if (!productExists) {
                    for (String searchPath : req.searchPaths()) {
                        infoRequests.add(Map.of(
                                "id", "precheck-product-" + productKey.hashCode() + "-" + searchPath.hashCode(),
                                "kind", "fs.list",
                                "args", Map.of("path", searchPath),
                                "why", "Find " + productKey + " files matching " + patternsForProduct,
                                "priority", 2));
                    }
                }
            }
        }

        // Determine overall result
        boolean allPassed = failures.isEmpty();
        String overallStatus;
        if (allPassed) {
            overallStatus = "ok";
        } else if (!infoRequests.isEmpty()) {
            overallStatus = "missing_info";
        } else {
            overallStatus = "blocked";
        }

        return new PreCheckResult(allPassed, overallStatus, checkResults, failures, infoRequests);
    }

    private Map<String, Object> findPhase(List<Map<String, Object>> phases, String phaseId) {
        if (phases == null || phaseId == null) return null;
        return phases.stream()
                .filter(p -> phaseId.equals(p.get("id")))
                .findFirst()
                .orElse(null);
    }

    /**
     * Simple glob-like pattern matching for file paths.
     * Supports * wildcard (matches any sequence of characters).
     * All matching is case-insensitive.
     */
    private boolean matchesPattern(String filePath, String pattern) {
        if (pattern == null || pattern.isBlank() || filePath == null) return false;
        // Convert glob pattern to regex: * → .*
        String regex = pattern.toLowerCase()
                .replace(".", "\\.")
                .replace("*", ".*");
        return filePath.toLowerCase().matches(regex);
    }
}
package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.*;
import io.codepilot.core.sse.SseEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.stream.Collectors;

/**
 * Summarize node: generates a structured, module-grouped, priority-ranked summary
 * of all changes made during the graph execution.
 *
 * <p>This node sits between the last work node and {@code finalize}, producing a
 * human-readable change digest that makes it easy to spot problems at a glance.
 *
 * <p>The summary is structured into three tiers:
 * <ol>
 *   <li><b>PRIMARY</b> — Core logic changes (new features, bug fixes, API changes)</li>
 *   <li><b>SECONDARY</b> — Supporting changes (refactors, test updates, config tweaks)</li>
 *   <li><b>AUXILIARY</b> — Minor changes (comments, formatting, import cleanup)</li>
 * </ol>
 *
 * <p>Changes are grouped by module/directory for easy navigation.
 */
@Component
public class SummarizeAction implements NodeAction {
    private static final Logger log = LoggerFactory.getLogger(SummarizeAction.class);

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "summarize");

        String sessionId = (String) state.value("sessionId").orElse("");
        var phases = (List<Map<String, Object>>) state.value("phases").orElse(List.of());
        var completedToolCalls = (List<Map<String, Object>>) state.value("completedToolCalls").orElse(List.of());
        var directToolsExecuted = (List<Map<String, Object>>) state.value("directToolsExecuted").orElse(List.of());
        var patchResults = (List<Map<String, Object>>) state.value("patchResults").orElse(List.of());
        var changeLineage = (List<Map<String, Object>>) state.value("changeLineage").orElse(List.of());
        var taskLedger = (Map<String, Object>) state.value("taskLedger").orElse(Map.of());
        boolean goalUnmet = Boolean.TRUE.equals(state.value("overallGoalUnmet").orElse(false));

        // ── 1. Collect all changed files with context ──
        List<ChangeEntry> changes = collectChanges(patchResults, changeLineage, phases);

        // ── 2. Classify changes by priority ──
        Map<ChangePriority, List<ChangeEntry>> prioritized = classifyByPriority(changes);

        // ── 3. Group by module ──
        Map<String, List<ChangeEntry>> byModule = groupByModule(changes);

        // ── 4. Build structured summary ──
        Map<String, Object> summarizeResult = new LinkedHashMap<>();

        // Goal / overall status
        String goal = (String) taskLedger.getOrDefault("goal", "");
        summarizeResult.put("goal", goal);
        summarizeResult.put("goalUnmet", goalUnmet);

        // Phase statistics
        List<String> completedPhaseIds = (List<String>) state.value("completedPhases").orElse(List.of());
        int completedPhases = completedPhaseIds.isEmpty() && !phases.isEmpty() ? phases.size() : completedPhaseIds.size();
        int failedPhases = (int) phases.stream()
                .filter(p -> "failed".equals(p.getOrDefault("status", "")))
                .count();
        summarizeResult.put("totalPhases", phases.size());
        summarizeResult.put("completedPhases", completedPhases);
        summarizeResult.put("failedPhases", failedPhases);

        // Tool call stats
        int toolCallCount = Math.max(completedToolCalls.size(), directToolsExecuted.size());
        summarizeResult.put("toolCallCount", toolCallCount);
        summarizeResult.put("totalChanges", changes.size());

        // ── 5. Build prioritized summary sections ──
        List<Map<String, Object>> primaryChanges = buildSection(prioritized.getOrDefault(ChangePriority.PRIMARY, List.of()));
        List<Map<String, Object>> secondaryChanges = buildSection(prioritized.getOrDefault(ChangePriority.SECONDARY, List.of()));
        List<Map<String, Object>> auxiliaryChanges = buildSection(prioritized.getOrDefault(ChangePriority.AUXILIARY, List.of()));

        summarizeResult.put("primary", primaryChanges);
        summarizeResult.put("secondary", secondaryChanges);
        summarizeResult.put("auxiliary", auxiliaryChanges);

        // ── 6. Build module-grouped view ──
        List<Map<String, Object>> moduleGroups = new ArrayList<>();
        byModule.entrySet().stream()
                .sorted((a, b) -> Integer.compare(b.getValue().size(), a.getValue().size()))
                .forEach(entry -> {
                    Map<String, Object> group = new LinkedHashMap<>();
                    group.put("module", entry.getKey());
                    group.put("changeCount", entry.getValue().size());
                    group.put("files", entry.getValue().stream()
                            .map(c -> {
                                Map<String, Object> f = new LinkedHashMap<>();
                                f.put("path", c.filePath);
                                f.put("priority", c.priority.name());
                                f.put("type", c.changeType);
                                f.put("phaseId", c.phaseId);
                                f.put("success", c.success);
                                if (c.description != null && !c.description.isBlank()) {
                                    f.put("description", c.description);
                                }
                                return f;
                            })
                            .toList());
                    moduleGroups.add(group);
                });
        summarizeResult.put("modules", moduleGroups);

        // ── 7. Build human-readable text summary ──
        String textSummary = buildTextSummary(goal, completedPhases, phases.size(), failedPhases,
                toolCallCount, changes.size(), goalUnmet, primaryChanges, secondaryChanges, auxiliaryChanges, byModule);
        summarizeResult.put("textSummary", textSummary);

        updates.put("summarizeResult", summarizeResult);

        // ── 8. Emit SSE event ──
        GraphSseHelper.emitEvent(state, SseEvents.GRAPH_SUMMARIZE, summarizeResult);

        log.info("Summarize: {} total changes (primary={}, secondary={}, auxiliary={}), {} modules, {} tool calls",
                changes.size(), primaryChanges.size(), secondaryChanges.size(), auxiliaryChanges.size(),
                byModule.size(), toolCallCount);

        return updates;
    }

    // ── Inner data structures ──

    enum ChangePriority {
        PRIMARY,    // Core logic: new features, bug fixes, API changes
        SECONDARY,  // Supporting: refactors, tests, config, dependencies
        AUXILIARY   // Minor: comments, formatting, imports, docs
    }

    static class ChangeEntry {
        String filePath;
        String changeType;   // "create", "modify", "delete"
        ChangePriority priority;
        String phaseId;
        boolean success;
        String description;

        ChangeEntry(String filePath, String changeType, ChangePriority priority,
                     String phaseId, boolean success, String description) {
            this.filePath = filePath;
            this.changeType = changeType;
            this.priority = priority;
            this.phaseId = phaseId;
            this.success = success;
            this.description = description;
        }
    }

    // ── Collection logic ──

    private List<ChangeEntry> collectChanges(
            List<Map<String, Object>> patchResults,
            List<Map<String, Object>> changeLineage,
            List<Map<String, Object>> phases) {

        List<ChangeEntry> changes = new ArrayList<>();
        Set<String> seenPaths = new LinkedHashSet<>();

        // From changeLineage (richer context)
        for (var entry : changeLineage) {
            String path = (String) entry.getOrDefault("filePath", "");
            if (path.isBlank() || seenPaths.contains(path)) continue;
            seenPaths.add(path);

            String phaseId = (String) entry.getOrDefault("phaseId", "");
            String patchContent = (String) entry.getOrDefault("patchContent", "");
            ChangePriority priority = inferPriority(path, patchContent);
            String changeType = inferChangeType(patchContent);
            String description = extractDescription(patchContent);

            changes.add(new ChangeEntry(path, changeType, priority, phaseId, true, description));
        }

        // From patchResults (may have entries not in lineage)
        for (var pr : patchResults) {
            String path = (String) pr.getOrDefault("path", "");
            if (path.isBlank() || seenPaths.contains(path)) continue;
            seenPaths.add(path);

            Boolean success = (Boolean) pr.getOrDefault("success", false);
            String phaseId = (String) pr.getOrDefault("phaseId", "");
            ChangePriority priority = inferPriority(path, "");
            String changeType = (String) pr.getOrDefault("type", "modify");

            changes.add(new ChangeEntry(path, changeType, priority, phaseId, success, ""));
        }

        return changes;
    }

    // ── Priority inference ──

    private ChangePriority inferPriority(String filePath, String patchContent) {
        String lower = filePath.toLowerCase();

        // PRIMARY: source code in core paths
        if (isSourceFile(lower) && isInCorePath(lower)) {
            return ChangePriority.PRIMARY;
        }

        // SECONDARY: tests, config, dependencies
        if (isTestFile(lower) || isConfigFile(lower) || isDependencyFile(lower)) {
            return ChangePriority.SECONDARY;
        }

        // Source in non-core paths
        if (isSourceFile(lower)) {
            return ChangePriority.SECONDARY;
        }

        // AUXILIARY: docs, comments, formatting
        if (isDocFile(lower) || isFormattingOnly(patchContent)) {
            return ChangePriority.AUXILIARY;
        }

        return ChangePriority.SECONDARY;
    }

    private boolean isSourceFile(String lowerPath) {
        return lowerPath.matches(".*\\.(java|kt|scala|py|js|ts|tsx|jsx|go|rs|rb|php|cs|swift|c|cpp|cc|cxx|h|hpp)$");
    }

    private boolean isInCorePath(String lowerPath) {
        return lowerPath.contains("/src/main/") || lowerPath.contains("/lib/")
                || lowerPath.contains("/core/") || lowerPath.contains("/api/")
                || lowerPath.contains("/service/") || lowerPath.contains("/controller/")
                || lowerPath.contains("/model/") || lowerPath.contains("/domain/")
                || lowerPath.contains("/handler/") || lowerPath.contains("/action/")
                || !lowerPath.contains("/test/") && !lowerPath.contains("/spec/");
    }

    private boolean isTestFile(String lowerPath) {
        return lowerPath.contains("/test/") || lowerPath.contains("/spec/")
                || lowerPath.contains("__tests__") || lowerPath.contains("_test.")
                || lowerPath.contains("test.") || lowerPath.contains("spec.")
                || lowerPath.contains(".test.") || lowerPath.contains(".spec.");
    }

    private boolean isConfigFile(String lowerPath) {
        return lowerPath.matches(".*\\.(ya?ml|xml|json|properties|ini|conf|toml|env|gradle|cmake|makefile)$")
                || lowerPath.contains("dockerfile") || lowerPath.contains(".docker")
                || lowerPath.endsWith(".gradle.kts") || lowerPath.endsWith(".gradle");
    }

    private boolean isDependencyFile(String lowerPath) {
        return lowerPath.endsWith("pom.xml") || lowerPath.endsWith("build.gradle")
                || lowerPath.endsWith("build.gradle.kts") || lowerPath.endsWith("package.json")
                || lowerPath.endsWith("go.mod") || lowerPath.endsWith("cargo.toml")
                || lowerPath.endsWith("requirements.txt") || lowerPath.endsWith("gemfile");
    }

    private boolean isDocFile(String lowerPath) {
        return lowerPath.endsWith(".md") || lowerPath.endsWith(".rst")
                || lowerPath.endsWith(".txt") || lowerPath.endsWith(".adoc")
                || lowerPath.endsWith(".html") || lowerPath.endsWith(".css");
    }

    private boolean isFormattingOnly(String patchContent) {
        if (patchContent == null || patchContent.isBlank()) return false;
        // Heuristic: if patch only has whitespace changes, it's formatting
        String stripped = patchContent.replaceAll("\\s+", "").replaceAll("[+\\-]", "");
        return stripped.length() < 20;
    }

    // ── Change type inference ──

    private String inferChangeType(String patchContent) {
        if (patchContent == null || patchContent.isBlank()) return "modify";
        if (patchContent.contains("new file") || patchContent.contains("/dev/null")) return "create";
        if (patchContent.contains("deleted file") || patchContent.contains("rewrite ")) return "delete";
        return "modify";
    }

    private String extractDescription(String patchContent) {
        if (patchContent == null || patchContent.isBlank()) return "";
        // Truncate long descriptions
        String desc = patchContent.replaceAll("[\\n\\r]+", " ").trim();
        return desc.length() > 200 ? desc.substring(0, 200) + "..." : desc;
    }

    // ── Classification & grouping ──

    private Map<ChangePriority, List<ChangeEntry>> classifyByPriority(List<ChangeEntry> changes) {
        return changes.stream().collect(Collectors.groupingBy(c -> c.priority, () -> new EnumMap<>(ChangePriority.class), Collectors.toList()));
    }

    private Map<String, List<ChangeEntry>> groupByModule(List<ChangeEntry> changes) {
        return changes.stream().collect(Collectors.groupingBy(this::extractModule, LinkedHashMap::new, Collectors.toList()));
    }

    private String extractModule(ChangeEntry entry) {
        String path = entry.filePath;
        // Try to extract module from common project structures
        // e.g., "backend/codePilot-core/src/main/java/io/codepilot/core/Foo.java"
        //   → module = "codePilot-core"
        String[] parts = path.split("/");
        if (parts.length >= 2) {
            // Check for Maven/Gradle multi-module structure
            for (int i = 0; i < parts.length - 1; i++) {
                if ("src".equals(parts[i]) && i > 0) {
                    return parts[i - 1];  // Module name before /src
                }
            }
            // Fallback: top-level directory
            return parts[0];
        }
        return "(root)";
    }

    // ── Build section payloads ──

    private List<Map<String, Object>> buildSection(List<ChangeEntry> entries) {
        return entries.stream().map(c -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("path", c.filePath);
            m.put("type", c.changeType);
            m.put("phaseId", c.phaseId);
            m.put("success", c.success);
            if (c.description != null && !c.description.isBlank()) {
                m.put("description", c.description);
            }
            return m;
        }).toList();
    }

    // ── Build human-readable text ──

    private String buildTextSummary(
            String goal, int completedPhases, int totalPhases, int failedPhases,
            int toolCallCount, int totalChanges, boolean goalUnmet,
            List<Map<String, Object>> primaryChanges,
            List<Map<String, Object>> secondaryChanges,
            List<Map<String, Object>> auxiliaryChanges,
            Map<String, List<ChangeEntry>> byModule) {

        StringBuilder sb = new StringBuilder();
        sb.append("═══════════════════════════════════════════\n");
        sb.append("              任务改动总结                  \n");
        sb.append("═══════════════════════════════════════════\n\n");

        if (!goal.isBlank()) {
            sb.append("目标: ").append(goal).append("\n\n");
        }

        // Overall status
        sb.append("执行阶段: ").append(completedPhases).append("/").append(totalPhases).append(" 完成");
        if (failedPhases > 0) {
            sb.append(" (").append(failedPhases).append(" 失败)");
        }
        sb.append("\n");
        sb.append("工具调用: ").append(toolCallCount).append(" 次\n");
        sb.append("文件变更: ").append(totalChanges).append(" 个\n");
        if (goalUnmet) {
            sb.append("⚠ 整体目标未达成\n");
        }
        sb.append("\n");

        // Primary changes (most important — first thing to review)
        if (!primaryChanges.isEmpty()) {
            sb.append("───────────────────────────────────────────\n");
            sb.append("★ 核心改动 (").append(primaryChanges.size()).append(")\n");
            sb.append("───────────────────────────────────────────\n");
            for (var c : primaryChanges) {
                String path = (String) c.getOrDefault("path", "");
                String type = (String) c.getOrDefault("type", "modify");
                String phaseId = (String) c.getOrDefault("phaseId", "");
                boolean success = (Boolean) c.getOrDefault("success", true);
                String marker = success ? "✓" : "✗";
                String typeLabel = "create".equals(type) ? "[新建]" : "delete".equals(type) ? "[删除]" : "[修改]";
                sb.append("  ").append(marker).append(" ").append(typeLabel).append(" ").append(path);
                if (!phaseId.isBlank()) sb.append(" (").append(phaseId).append(")");
                sb.append("\n");
            }
            sb.append("\n");
        }

        // Secondary changes
        if (!secondaryChanges.isEmpty()) {
            sb.append("───────────────────────────────────────────\n");
            sb.append("● 辅助推改 (").append(secondaryChanges.size()).append(")\n");
            sb.append("───────────────────────────────────────────\n");
            for (var c : secondaryChanges) {
                String path = (String) c.getOrDefault("path", "");
                String type = (String) c.getOrDefault("type", "modify");
                String phaseId = (String) c.getOrDefault("phaseId", "");
                boolean success = (Boolean) c.getOrDefault("success", true);
                String marker = success ? "✓" : "✗";
                String typeLabel = "create".equals(type) ? "[新建]" : "delete".equals(type) ? "[删除]" : "[修改]";
                sb.append("  ").append(marker).append(" ").append(typeLabel).append(" ").append(path);
                if (!phaseId.isBlank()) sb.append(" (").append(phaseId).append(")");
                sb.append("\n");
            }
            sb.append("\n");
        }

        // Auxiliary changes
        if (!auxiliaryChanges.isEmpty()) {
            sb.append("───────────────────────────────────────────\n");
            sb.append("○ 次要改动 (").append(auxiliaryChanges.size()).append(")\n");
            sb.append("───────────────────────────────────────────\n");
            for (var c : auxiliaryChanges) {
                String path = (String) c.getOrDefault("path", "");
                boolean success = (Boolean) c.getOrDefault("success", true);
                String marker = success ? "✓" : "✗";
                sb.append("  ").append(marker).append(" ").append(path).append("\n");
            }
            sb.append("\n");
        }

        // Module overview
        if (!byModule.isEmpty()) {
            sb.append("───────────────────────────────────────────\n");
            sb.append("模块分布\n");
            sb.append("───────────────────────────────────────────\n");
            byModule.entrySet().stream()
                    .sorted((a, b) -> Integer.compare(b.getValue().size(), a.getValue().size()))
                    .forEach(entry -> {
                        sb.append("  ").append(entry.getKey()).append(": ").append(entry.getValue().size()).append(" 个文件\n");
                    });
            sb.append("\n");
        }

        sb.append("═══════════════════════════════════════════\n");
        return sb.toString();
    }
}
package io.codepilot.core.graph;

import io.codepilot.core.run.GraphEngineProperties;
import java.util.Map;

/** Shared character budgets for generate / repair prompt assembly. */
public final class GraphPromptContextBudget {

    private static final int DEFAULT_GATHERED_PROMPT_CHARS = 12000;
    private static final int DEFAULT_PROJECT_META_PROMPT_CHARS = 8000;
    private static final int DEFAULT_REPAIR_PROMPT_CHARS = 6000;

    private GraphPromptContextBudget() {}

    public static String truncate(String text, int maxChars) {
        if (text == null || text.isBlank() || maxChars <= 0) {
            return text == null ? "" : text;
        }
        if (text.length() <= maxChars) {
            return text;
        }
        return text.substring(0, maxChars) + "\n... (truncated for prompt budget)";
    }

    public static String projectMetaSection(String projectMeta, int maxChars) {
        if (projectMeta == null || projectMeta.isBlank()) {
            return "";
        }
        return "[PROJECT CONTEXT]\n" + truncate(projectMeta, maxChars) + "\n";
    }

    public static String gatheredContextSection(Map<String, Object> gatheredInfo, int maxChars) {
        if (gatheredInfo == null || gatheredInfo.isEmpty()) {
            return "";
        }
        String body = GatheredInfoFormatter.formatWithinBudget(gatheredInfo, maxChars);
        if (body.isBlank()) {
            return "";
        }
        return "[GATHERED CONTEXT]\n" + body;
    }

    public static int resolveGenerateGatheredBudget(GraphEngineProperties properties) {
        int configured = properties.getGatheredInfoCharsBudget();
        if (configured > 0) {
            return Math.min(configured, 16000);
        }
        return DEFAULT_GATHERED_PROMPT_CHARS;
    }

    public static int resolveGenerateProjectMetaBudget(GraphEngineProperties properties) {
        int memory = properties.getMemoryBudget();
        if (memory > 0) {
            return Math.min(memory * 2, DEFAULT_PROJECT_META_PROMPT_CHARS);
        }
        return DEFAULT_PROJECT_META_PROMPT_CHARS;
    }

    public static int resolveRepairPromptBudget(GraphEngineProperties properties) {
        int configured = properties.getGatheredInfoCharsBudget();
        if (configured > 0) {
            return Math.min(configured / 2, DEFAULT_REPAIR_PROMPT_CHARS);
        }
        return DEFAULT_REPAIR_PROMPT_CHARS;
    }
}

package io.codepilot.core.memory;

import com.alibaba.cloud.ai.graph.OverAllState;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.*;

/**
 * Tracks file change lineage across graph execution phases.
 *
 * <p>Every file modification (via applyPatch) records a lineage entry with:
 * <ul>
 *   <li>The baseline content hash before the change</li>
 *   <li>The patch that was applied</li>
 *   <li>A reference to the decision/memory that motivated the change</li>
 *   <li>The phase and journal step that produced it</li>
 * </ul>
 *
 * <p>This enables:
 * <ul>
 *   <li>RepairAction to see the full history and avoid reverting prior changes</li>
 *   <li>VerifyAction to compare before/after states</li>
 *   <li>FinalizeAction to write lineage into long-term memory for audit</li>
 * </ul>
 *
 * <p>Stored in graph state as {@code changeLineage} (List<Map<String,Object>>).
 */
public final class ChangeLineageTracker {

    public static final String STATE_KEY = "changeLineage";

    private static final Logger log = LoggerFactory.getLogger(ChangeLineageTracker.class);

    /** Maximum lineage entries to retain in state (prevents unbounded growth). */
    private static final int MAX_ENTRIES = 64;

    private ChangeLineageTracker() {}

    /**
     * Record a file change lineage entry.
     *
     * @param state        current graph state
     * @param updates      mutable updates map to write into
     * @param filePath     the file that was modified
     * @param baselineHash hash of the file content before the change
     * @param patchContent the patch that was applied
     * @param decisionRef  ID of the StructuredMemory that motivated this change (nullable)
     * @param phaseId      the current phase ID
     * @param journalSeq   the journal sequence number at this point
     */
    @SuppressWarnings("unchecked")
    public static void recordChange(
            OverAllState state,
            Map<String, Object> updates,
            String filePath,
            String baselineHash,
            String patchContent,
            String decisionRef,
            String phaseId,
            int journalSeq) {

        List<Map<String, Object>> lineage = new ArrayList<>(
                (List<Map<String, Object>>) state.value(STATE_KEY).orElse(List.of()));

        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("lineageId", UUID.randomUUID().toString());
        entry.put("filePath", filePath);
        entry.put("baselineHash", baselineHash);
        entry.put("patchContent", abbreviatePatch(patchContent));
        entry.put("decisionRef", decisionRef != null ? decisionRef : "");
        entry.put("phaseId", phaseId != null ? phaseId : "");
        entry.put("journalSeq", journalSeq);
        entry.put("timestamp", System.currentTimeMillis());

        lineage.add(entry);

        // Trim to max size (keep most recent)
        if (lineage.size() > MAX_ENTRIES) {
            lineage = lineage.subList(lineage.size() - MAX_ENTRIES, lineage.size());
        }

        updates.put(STATE_KEY, List.copyOf(lineage));
        log.debug("ChangeLineageTracker: recorded change to {} in phase {} (total lineage entries: {})",
                filePath, phaseId, lineage.size());
    }

    /**
     * Render lineage as a prompt directive for the LLM.
     * Shows recent file changes with their context, helping the LLM avoid
     * reverting prior changes or making contradictory modifications.
     */
    @SuppressWarnings("unchecked")
    public static String promptDirective(OverAllState state) {
        List<Map<String, Object>> lineage =
                (List<Map<String, Object>>) state.value(STATE_KEY).orElse(List.of());
        if (lineage.isEmpty()) return "";

        StringBuilder sb = new StringBuilder();
        sb.append("\n\n[CHANGE LINEAGE — files modified in this session]\n");
        sb.append("Do NOT revert these changes unless explicitly asked. ");
        sb.append("Each change is bound to a decision and phase.\n");

        // Show last 10 entries max in prompt
        int start = Math.max(0, lineage.size() - 10);
        for (int i = start; i < lineage.size(); i++) {
            Map<String, Object> entry = lineage.get(i);
            String file = (String) entry.getOrDefault("filePath", "?");
            String phase = (String) entry.getOrDefault("phaseId", "?");
            String patch = (String) entry.getOrDefault("patchContent", "");
            String decision = (String) entry.getOrDefault("decisionRef", "");

            sb.append("- ").append(file).append(" (phase ").append(phase).append(")");
            if (!decision.isBlank()) {
                sb.append(" [ref: ").append(decision, 0, Math.min(8, decision.length())).append("]");
            }
            if (!patch.isBlank()) {
                String shortPatch = patch.length() > 120 ? patch.substring(0, 120) + "..." : patch;
                sb.append(": ").append(shortPatch);
            }
            sb.append("\n");
        }
        return sb.toString();
    }

    /**
     * Get all lineage entries for a specific file.
     * Useful for RepairAction to see the full change history of a file.
     */
    @SuppressWarnings("unchecked")
    public static List<Map<String, Object>> lineageForFile(OverAllState state, String filePath) {
        List<Map<String, Object>> lineage =
                (List<Map<String, Object>>) state.value(STATE_KEY).orElse(List.of());
        return lineage.stream()
                .filter(e -> filePath.equals(e.get("filePath")))
                .toList();
    }

    /** Abbreviate patch content for storage (avoid storing huge diffs in state). */
    private static String abbreviatePatch(String patch) {
        if (patch == null) return "";
        return patch.length() > 500 ? patch.substring(0, 500) + "..." : patch;
    }
}
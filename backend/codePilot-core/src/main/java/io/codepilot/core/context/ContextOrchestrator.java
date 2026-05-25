package io.codepilot.core.context;

import io.codepilot.core.memory.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.stream.Collectors;

/**
 * Context orchestration engine — replaces the passive trim-only approach of
 * ContextBudgeter with an active, memory-layer-aware context assembly strategy.
 *
 * <h3>Cold/hot dispatch:</h3>
 * <ul>
 *   <li><b>Hot (always loaded):</b> IMMORTAL memories, current user input, active phase context</li>
 *   <li><b>Warm (selectively loaded):</b> PROTECTED memories relevant to current task</li>
 *   <li><b>Cold (on-demand):</b> DEGRADABLE/VOLATILE memories, compressed when over budget</li>
 * </ul>
 *
 * <h3>Mounting strategy per layer:</h3>
 * <ul>
 *   <li>INSTANTANEOUS → direct injection into conversationHistory</li>
 *   <li>SHORT_TERM → [SESSION CONTEXT] section in system prompt</li>
 *   <li>LONG_TERM → [PROJECT MEMORY] section in system prompt</li>
 *   <li>GLOBAL → PromptRegistry rules (always mounted, volume-controlled)</li>
 * </ul>
 *
 * <p>This service is called by MemoryLoadAction to shape the activeMemories
 * before they are injected into graph state.
 */
@Service
public class ContextOrchestrator {

    private static final Logger log = LoggerFactory.getLogger(ContextOrchestrator.class);
    private final TokenMeter meter;

    /** Default token budget for memory context (separate from LLM context budget). */
    private static final int DEFAULT_MEMORY_BUDGET = 6000;
    /** Maximum tokens for a single memory's detail when mounted. */
    private static final int MAX_DETAIL_TOKENS = 800;

    public ContextOrchestrator(TokenMeter meter) {
        this.meter = meter;
    }

    /**
     * Result of orchestration — carries the trimmed memory list and metadata
     * about whether the programmatic trimming was sufficient.
     *
     * @param memories       the orchestrated memories within budget
     * @param originalCount  total memories before orchestration
     * @param trimmedCount   memories after orchestration
     * @param tokensUsed     total tokens consumed by the orchestrated memories
     * @param tokensBudget   the budget that was applied
     * @param overBudget     true if some memories were dropped or compressed
     *                       and LLM-assisted compaction may further help
     */
    public record OrchestrationResult(
            List<StructuredMemory> memories,
            int originalCount,
            int trimmedCount,
            int tokensUsed,
            int tokensBudget,
            boolean overBudget) {}

    /**
     * Orchestrate the active memories: apply cold/hot dispatch, compression
     * protection, and mounting strategy to produce the final list of memories
     * that will be injected into the LLM prompt.
     *
     * @param allMemories memories from all four layers (as loaded by MemoryLoadAction)
     * @param budget      maximum tokens for memory context
     * @return orchestrated result including trimmed memories and budget metadata
     */
    public OrchestrationResult orchestrate(List<StructuredMemory> allMemories, int budget) {
        if (allMemories == null || allMemories.isEmpty()) {
            return new OrchestrationResult(List.of(), 0, 0, 0, budget > 0 ? budget : DEFAULT_MEMORY_BUDGET, false);
        }
        int effectiveBudget = budget > 0 ? budget : DEFAULT_MEMORY_BUDGET;

        // Phase 1: Separate hot/warm/cold
        List<StructuredMemory> hot = new ArrayList<>();
        List<StructuredMemory> warm = new ArrayList<>();
        List<StructuredMemory> cold = new ArrayList<>();

        for (StructuredMemory m : allMemories) {
            switch (m.protection()) {
                case IMMORTAL -> hot.add(m);
                case PROTECTED -> warm.add(m);
                case DEGRADABLE, VOLATILE -> cold.add(m);
            }
        }

        // Phase 2: Build result — hot always included
        List<StructuredMemory> result = new ArrayList<>(hot);
        int usedTokens = countTokens(hot);

        // Phase 3: Add warm (sorted by relevance — newer first)
        warm.sort(Comparator.comparingLong(StructuredMemory::updatedAt).reversed());
        for (StructuredMemory m : warm) {
            int mTokens = countTokens(m);
            if (usedTokens + mTokens <= effectiveBudget) {
                result.add(m);
                usedTokens += mTokens;
            }
        }

        // Phase 4: Add cold (sorted by recency, compressed if needed)
        cold.sort(Comparator.comparingLong(StructuredMemory::updatedAt).reversed());
        for (StructuredMemory m : cold) {
            int mTokens = countTokens(m);
            if (usedTokens + mTokens <= effectiveBudget) {
                result.add(m);
                usedTokens += mTokens;
            } else if (usedTokens + meter.count(m.summary()) <= effectiveBudget) {
                // Compress: keep summary only, drop detail
                result.add(new StructuredMemory(
                        m.id(), m.layer(), m.protection(), m.type(),
                        m.summary(), null, m.tags(),
                        m.createdAt(), m.updatedAt(), m.sourcePhaseId()));
                usedTokens += meter.count(m.summary());
            }
        }

        // Determine if budget pressure requires LLM-assisted compaction
        boolean overBudget = result.size() < allMemories.size();

        log.info("ContextOrchestrator: orchestrated {} → {} memories (hot={}, warm={}, cold={}), {} tokens used / {} budget, overBudget={}",
                allMemories.size(), result.size(), hot.size(), warm.size(), cold.size(),
                usedTokens, effectiveBudget, overBudget);

        return new OrchestrationResult(result, allMemories.size(), result.size(),
                usedTokens, effectiveBudget, overBudget);
    }

    /**
     * Render the orchestrated memories as prompt sections for LLM injection.
     * Produces [SESSION CONTEXT] and [PROJECT MEMORY] sections.
     */
    public String renderPromptSections(List<StructuredMemory> memories) {
        if (memories == null || memories.isEmpty()) return "";

        StringBuilder sb = new StringBuilder();

        // [SESSION CONTEXT] — SHORT_TERM layer
        List<StructuredMemory> sessionMemories = memories.stream()
                .filter(m -> m.layer() == MemoryLayer.SHORT_TERM)
                .toList();
        if (!sessionMemories.isEmpty()) {
            sb.append("\n[SESSION CONTEXT — key facts from this session]\n");
            for (StructuredMemory m : sessionMemories) {
                sb.append("- ").append(m.summary());
                if (m.protection() == ProtectionLevel.IMMORTAL) sb.append(" [IMMORTAL]");
                sb.append("\n");
                if (m.detail() != null && !m.detail().isBlank()
                        && m.protection().ordinal() <= ProtectionLevel.PROTECTED.ordinal()) {
                    String truncated = m.detail().length() > 300
                            ? m.detail().substring(0, 300) + "..." : m.detail();
                    sb.append("  ").append(truncated).append("\n");
                }
            }
        }

        // [PROJECT MEMORY] — LONG_TERM layer
        List<StructuredMemory> projectMemories = memories.stream()
                .filter(m -> m.layer() == MemoryLayer.LONG_TERM)
                .toList();
        if (!projectMemories.isEmpty()) {
            sb.append("\n[PROJECT MEMORY — accumulated project knowledge]\n");
            for (StructuredMemory m : projectMemories) {
                sb.append("- [").append(m.type()).append("] ").append(m.summary()).append("\n");
            }
        }

        return sb.toString();
    }

    // ── Token counting helpers ──

    private int countTokens(List<StructuredMemory> memories) {
        return memories.stream().mapToInt(this::countTokens).sum();
    }

    private int countTokens(StructuredMemory m) {
        int n = meter.count(m.summary());
        if (m.detail() != null && !m.detail().isBlank()) {
            // Cap detail contribution to MAX_DETAIL_TOKENS
            int detailTokens = meter.count(m.detail());
            n += Math.min(detailTokens, MAX_DETAIL_TOKENS);
        }
        return n;
    }
}
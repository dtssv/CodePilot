package io.codepilot.core.graph;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.context.ContextOrchestrator;
import io.codepilot.core.memory.*;
import io.codepilot.core.run.GraphEngineProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.stream.Collectors;

/**
 * Phase-aware memory loader: injects project memories and context shards for the
 * upcoming phase using LLM-declared {@code tags}, {@code memoryHints}, and
 * {@code loadShardMode} only.
 */
@Component
public class PhaseAwareMemoryLoader {

    private static final Logger log = LoggerFactory.getLogger(PhaseAwareMemoryLoader.class);

    private final ProjectMemoryStore projectMemoryStore;
    private final ContextShardStore shardStore;
    private final ContextOrchestrator contextOrchestrator;
    private final GraphEngineProperties graphProperties;

    public PhaseAwareMemoryLoader(ProjectMemoryStore projectMemoryStore,
                                  ContextShardStore shardStore,
                                  ContextOrchestrator contextOrchestrator,
                                  GraphEngineProperties graphProperties) {
        this.projectMemoryStore = projectMemoryStore;
        this.shardStore = shardStore;
        this.contextOrchestrator = contextOrchestrator;
        this.graphProperties = graphProperties;
    }

    @SuppressWarnings("unchecked")
    public List<StructuredMemory> loadForNextPhase(OverAllState state,
                                                    Map<String, Object> updates,
                                                    String nextPhaseId) {
        List<Map<String, Object>> phases =
                (List<Map<String, Object>>) state.value("phases").orElse(List.of());
        Map<String, Object> phase = PhaseMemoryHelper.findPhase(phases, nextPhaseId);
        List<String> queryTags = PhaseMemoryHelper.queryTagsFromPhase(phase);
        return loadWithQueryTags(state, updates, nextPhaseId, phase, queryTags);
    }

    public List<StructuredMemory> loadWithExplicitTags(OverAllState state,
                                                        Map<String, Object> updates,
                                                        String nextPhaseId,
                                                        List<String> queryTags) {
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> phases =
                (List<Map<String, Object>>) state.value("phases").orElse(List.of());
        Map<String, Object> phase = PhaseMemoryHelper.findPhase(phases, nextPhaseId);
        return loadWithQueryTags(state, updates, nextPhaseId, phase, queryTags);
    }

    @SuppressWarnings("unchecked")
    private List<StructuredMemory> loadWithQueryTags(OverAllState state,
                                                      Map<String, Object> updates,
                                                      String nextPhaseId,
                                                      Map<String, Object> phase,
                                                      List<String> queryTags) {

        String projectRootHash = (String) state.value("projectRootHash").orElse("");
        if (projectRootHash.isBlank()) {
            return List.of();
        }

        PhaseMemoryHelper.LoadShardMode shardMode = PhaseMemoryHelper.LoadShardMode.fromPhase(phase);
        if (queryTags.isEmpty() && shardMode == PhaseMemoryHelper.LoadShardMode.TAGS) {
            log.info("PhaseAwareMemoryLoader: no tags/memoryHints for phase {} — skipping phase-specific load",
                    nextPhaseId);
            return List.of();
        }

        int maxMemories = graphProperties.getMaxProjectMemories() > 0
                ? graphProperties.getMaxProjectMemories() : 20;

        List<StructuredMemory> phaseMemories = List.of();
        if (!queryTags.isEmpty()) {
            try {
                phaseMemories = projectMemoryStore
                        .loadByTags(projectRootHash, queryTags, maxMemories)
                        .block();
                if (phaseMemories == null) {
                    phaseMemories = List.of();
                }
            } catch (Exception e) {
                log.warn("PhaseAwareMemoryLoader: failed to load project memories for phase {} (non-fatal): {}",
                        nextPhaseId, e.getMessage());
            }
        }

        String contextSourceId = (String) state.value("contextSourceId").orElse("");
        List<ContextShardStore.ContextShard> phaseShards =
                ContextShardResolver.resolveShards(
                        shardStore, projectRootHash, contextSourceId, queryTags, shardMode);

        List<StructuredMemory> shardMemories = phaseShards.stream()
                .map(shard -> {
                    long now = System.currentTimeMillis();
                    String shardDetail = (shard.summary() != null && !shard.summary().isBlank())
                            ? shard.summary() : shard.content();
                    return new StructuredMemory(
                            "shard_" + shard.id(),
                            MemoryLayer.LONG_TERM,
                            ProtectionLevel.PROTECTED,
                            MemoryType.FACT,
                            String.join(", ", shard.tags()),
                            shardDetail,
                            shard.tags(),
                            now, now,
                            "context-split");
                })
                .collect(Collectors.toList());

        List<StructuredMemory> allNewMemories = new ArrayList<>(phaseMemories);
        allNewMemories.addAll(shardMemories);

        List<Map<String, Object>> existingActiveMemories =
                (List<Map<String, Object>>) state.value("activeMemories").orElse(List.of());
        Set<String> existingIds = existingActiveMemories.stream()
                .map(m -> (String) m.getOrDefault("id", ""))
                .collect(Collectors.toSet());

        List<StructuredMemory> newMemories = allNewMemories.stream()
                .filter(m -> !existingIds.contains(m.id()))
                .toList();

        if (newMemories.isEmpty()) {
            log.info("PhaseAwareMemoryLoader: no new memories to add for phase {}", nextPhaseId);
            return List.of();
        }

        int phaseBudget = graphProperties.getMemoryBudget() > 0
                ? graphProperties.getMemoryBudget() / 2 : 3000;

        var orchestrationResult = contextOrchestrator.orchestrate(newMemories, phaseBudget);
        List<StructuredMemory> orchestratedNew = orchestrationResult.memories();

        List<Map<String, Object>> merged = new ArrayList<>(existingActiveMemories);
        orchestratedNew.stream()
                .map(StructuredMemory::toMap)
                .forEach(merged::add);

        updates.put("activeMemories", merged);
        updates.put("memoryBudget", graphProperties.getMemoryBudget());

        log.info("PhaseAwareMemoryLoader: phase {} tags={}, shardMode={}, +{} memories (total {})",
                nextPhaseId, queryTags, shardMode, orchestratedNew.size(), merged.size());

        return orchestratedNew;
    }
}

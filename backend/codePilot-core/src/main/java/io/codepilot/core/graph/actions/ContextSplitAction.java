package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.graph.*;
import io.codepilot.core.prompt.PromptRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Splits a large input/context into labeled shards and persists them to Redis
 * via {@link ContextShardStore}.
 *
 * <p>This node sits between {@code intake} and {@code memoryLoad} in the graph.
 * When the user's input exceeds a token threshold, this node calls the LLM to
 * plan the split. The LLM decides:
 * <ul>
 *   <li>How many shards to create</li>
 *   <li>What content goes into each shard</li>
 *   <li>What tags each shard gets (for later retrieval by phase-aware loaders)</li>
 * </ul>
 *
 * <p><b>Design principle: LLM decides the split strategy.</b> The engineering code
 * only executes the LLM's plan — it never assumes whether the input is a design
 * document, codebase analysis, API spec, or any other specific format.
 *
 * <p>If the input is small (below threshold), this node skips splitting and passes
 * through to the next node.
 */
@Component
public class ContextSplitAction implements NodeAction {

    private static final Logger log = LoggerFactory.getLogger(ContextSplitAction.class);

    private final ContextShardStore shardStore;
    private final GraphAuxiliaryModelResolver auxiliaryModelResolver;
    private final PromptRegistry promptRegistry;
    private final ObjectMapper mapper;
    private final io.codepilot.core.run.GraphEngineProperties graphProperties;

    public ContextSplitAction(ContextShardStore shardStore,
                              GraphAuxiliaryModelResolver auxiliaryModelResolver,
                              PromptRegistry promptRegistry,
                              ObjectMapper mapper,
                              io.codepilot.core.run.GraphEngineProperties graphProperties) {
        this.shardStore = shardStore;
        this.auxiliaryModelResolver = auxiliaryModelResolver;
        this.promptRegistry = promptRegistry;
        this.mapper = mapper;
        this.graphProperties = graphProperties;
    }

    private int splitCharThreshold() {
        int v = graphProperties.getContextSplitCharThreshold();
        return v > 0 ? v : 32000;
    }

    private int maxCharsPerLlmCall() {
        int v = graphProperties.getContextSplitMaxCharsPerLlmCall();
        return v > 0 ? v : 400000;
    }

    private int fallbackChunkSize() {
        int v = graphProperties.getContextSplitFallbackChunkSize();
        return v > 0 ? v : 8000;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "contextSplit");
        GraphExecutionLog.nodeEnter(state, "contextSplit");

        // ★ Carry over resumeNextNode so it survives the intake→contextSplit→memoryLoad path.
        state.<String>value("resumeNextNode").ifPresent(v -> {
            if (!v.isBlank()) updates.put("resumeNextNode", v);
        });

        String input = (String) state.value("input").orElse("");
        String projectRootHash = (String) state.value("projectRootHash").orElse("");

        // ★ Compute effective context size: input + projectMeta
        // The actual LLM prompt includes not just input but also projectMeta,
        // gatheredContext, memoryDirective etc. Checking only input.length() misses
        // cases where projectMeta is huge (e.g. SQL file embedded in project context).
        String projectMeta = (String) state.value("projectMeta").orElse("");
        int effectiveContextChars = input.length() + projectMeta.length();

        // Skip if effective context is small or no project context
        int threshold = splitCharThreshold();
        if (effectiveContextChars < threshold || projectRootHash.isBlank()) {
            log.info("ContextSplitAction: effectiveContext={} chars (input={}, projectMeta={}) threshold={}, skipping split",
                    effectiveContextChars, input.length(), projectMeta.length(), threshold);
            updates.put("contextSplitResult", "skipped");
            GraphExecutionLog.nodeExit(state, "contextSplit", updates);
            return updates;
        }

        log.info("ContextSplitAction: effectiveContext={} chars (input={}, projectMeta={}) exceeds threshold={}, splitting context",
                effectiveContextChars, input.length(), projectMeta.length(), threshold);

        int maxPerCall = maxCharsPerLlmCall();
        List<ContextShardStore.ContextShard> allShards = new ArrayList<>();
        String sourceId = "input-ctx-" + System.currentTimeMillis();

        // ★ Combine input + projectMeta for splitting — both contribute to prompt size.
        // Structure the combined content so the LLM can understand the two sections
        // and split them into meaningful shards with appropriate tags.
        String combinedContent = buildCombinedContentForSplit(input, projectMeta);

        if (combinedContent.length() <= maxPerCall) {
            allShards.addAll(splitSegment(state, combinedContent, updates, 0));
        } else {
            int batchCount = (int) Math.ceil((double) combinedContent.length() / maxPerCall);
            log.info("ContextSplitAction: large context ({} chars), splitting into {} batches for LLM",
                    combinedContent.length(), batchCount);

            int offset = 0;
            int batchIdx = 0;
            while (offset < combinedContent.length()) {
                int end = Math.min(offset + maxPerCall, combinedContent.length());
                String chunk = combinedContent.substring(offset, end);

                log.info("ContextSplitAction: processing batch {}/{}, chars {}-{}",
                        batchIdx + 1, batchCount, offset, end);

                List<ContextShardStore.ContextShard> chunkShards =
                        splitSegment(state, chunk, updates, batchIdx);

                if (chunkShards.isEmpty()) {
                    // Rule + LLM split failed — use fixed-size fallback chunking
                    allShards.addAll(fallbackChunkSegment(chunk, batchIdx));
                } else {
                    // LLM split succeeded — prefix shard IDs with batch index for uniqueness
                    for (var shard : chunkShards) {
                        var renamed = new ContextShardStore.ContextShard(
                                "b" + batchIdx + "_" + shard.id(),
                                shard.sourceId(),
                                shard.tags(),
                                shard.contentType(),
                                shard.content(),
                                shard.summary(),
                                shard.metadata(),
                                shard.tokenEstimate());
                        allShards.add(renamed);
                    }
                }

                offset = end;
                batchIdx++;
            }
        }

        // ── Save all shards ──
        if (allShards.isEmpty()) {
            log.warn("ContextSplitAction: no shards produced, using full fallback");
            fallbackChunkAndSave(combinedContent, projectRootHash, updates);
            updates.put("contextSplitResult", "fallback");
        } else {
            Long saved = shardStore.saveAll(projectRootHash, sourceId, allShards).block();
            updates.put("contextSourceId", sourceId);
            updates.put("contextShardCount", allShards.size());
            updates.put("contextSplitResult", "split");

            // ★ Replace input and projectMeta with concise references when context has been split.
            // Downstream nodes (PlanningAction, GenerateAction) will use shard summaries
            // instead of the full input, preventing the 29万chars prompt explosion.
            // We preserve the first 500 chars of input so the planner understands the
            // user's intent, plus a note about available shards.
            String inputAbbrev = input.length() > 500
                    ? input.substring(0, 500) + "... (full content split into "
                    + allShards.size() + " context sections)"
                    : input;
            updates.put("input", inputAbbrev);

            // ★ Abbreviate projectMeta similarly — the full project context is now in shards.
            if (projectMeta.length() > 500) {
                String projectMetaAbbrev = projectMeta.substring(0, 500)
                        + "... (full project context split into context sections)";
                updates.put("projectMeta", projectMetaAbbrev);
            }

            log.info("ContextSplitAction: split context into {} shards, saved {} (sourceId={}). "
                    + "Input abbreviated from {} to {} chars, projectMeta abbreviated from {} to {} chars",
                    allShards.size(), saved, sourceId,
                    input.length(), inputAbbrev.length(),
                    projectMeta.length(), projectMeta.length() > 500 ? projectMeta.substring(0, 500).length() + 60 : projectMeta.length());
        }

        GraphExecutionLog.nodeExit(state, "contextSplit", updates);
        return updates;
    }

    /**
     * Split a segment: rule-based first (no LLM), then LLM planner, then empty for caller fallback.
     */
    private List<ContextShardStore.ContextShard> splitSegment(
            OverAllState state, String segment, Map<String, Object> updates, int batchIdx) {
        int chunkSize = fallbackChunkSize();
        List<ContextShardStore.ContextShard> ruleShards =
                ContextShardRuleSplitter.split(segment, "input-ctx", batchIdx, chunkSize);
        if (ContextShardRuleSplitter.isViable(ruleShards, segment)) {
            log.info(
                    "ContextSplitAction: rule-based split produced {} shards for segment ({} chars), skipping LLM",
                    ruleShards.size(),
                    segment.length());
            return ruleShards;
        }
        List<ContextShardStore.ContextShard> llmShards = splitWithLlm(state, segment, updates);
        if (!llmShards.isEmpty()) {
            return llmShards;
        }
        if (!ruleShards.isEmpty()) {
            log.info(
                    "ContextSplitAction: using {} rule shards as LLM fallback for segment ({} chars)",
                    ruleShards.size(),
                    segment.length());
            return ruleShards;
        }
        return List.of();
    }

    /** Attempt to split an input segment using LLM. Returns empty list on failure. */
    private List<ContextShardStore.ContextShard> splitWithLlm(OverAllState state, String segment, Map<String, Object> updates) {
        String splitPrompt = buildSplitPrompt(segment);
        try {
            String llmResponse =
                    auxiliaryModelResolver.streamUserPromptToSse(
                            state, "context-split", splitPrompt, updates);
            return parseSplitPlan(llmResponse, segment);
        } catch (Exception e) {
            log.warn("ContextSplitAction: LLM split failed for segment ({} chars): {}",
                    segment.length(), e.getMessage());
            return List.of();
        }
    }

    /** Fallback: chunk a segment into fixed-size pieces with sequential tags. */
    private List<ContextShardStore.ContextShard> fallbackChunkSegment(String segment, int batchIdx) {
        int chunkSize = fallbackChunkSize();
        List<ContextShardStore.ContextShard> shards = new ArrayList<>();
        int offset = 0;
        int idx = 0;
        while (offset < segment.length()) {
            int end = Math.min(offset + chunkSize, segment.length());
            String chunk = segment.substring(offset, end);
            shards.add(new ContextShardStore.ContextShard(
                    "shard_b" + batchIdx + "_" + idx,
                    "input-ctx",
                    List.of("chunk-b" + batchIdx + "-" + idx, "fallback-split", "batch-" + batchIdx),
                    "text_chunk",
                    chunk,
                    Map.of("batchIndex", batchIdx, "chunkIndex", idx, "offset", offset),
                    chunk.length() / 4
            ));
            offset = end;
            idx++;
        }
        return shards;
    }

    /** Build the prompt for LLM to plan the context split. */
    private String buildSplitPrompt(String input) {
        return String.format(promptRegistry.get("graph.context-split"), input);
    }

    /** Parse LLM's split plan and extract shard content from the original input. */
    @SuppressWarnings("unchecked")
    private List<ContextShardStore.ContextShard> parseSplitPlan(String llmResponse, String originalInput) throws Exception {
        String json = LlmJsonExtract.parseableJson(llmResponse);
        JsonNode root = mapper.readTree(json);
        JsonNode planNode = root.get("splitPlan");
        if (planNode == null || !planNode.isArray() || planNode.isEmpty()) {
            throw new IllegalArgumentException("No splitPlan array in LLM response");
        }

        List<ContextShardStore.ContextShard> shards = new ArrayList<>();
        for (JsonNode planItem : planNode) {
            String id = planItem.path("id").asText("shard_" + shards.size());
            List<String> tags = new ArrayList<>();
            JsonNode tagsNode = planItem.get("tags");
            if (tagsNode != null && tagsNode.isArray()) {
                for (JsonNode t : tagsNode) tags.add(t.asText());
            }
            String contentType = planItem.path("contentType").asText("unknown");
            String summary = planItem.path("summary").asText("");
            String startMarker = planItem.path("contentStartMarker").asText("");
            String endMarker = planItem.path("contentEndMarker").asText("");
            int tokenEstimate = planItem.path("tokenEstimate").asInt(500);

            String content = extractContentBetweenMarkers(originalInput, startMarker, endMarker);
            if (content.isBlank()) {
                log.warn("ContextSplitAction: empty content for shard {} (startMarker='{}')", id, startMarker);
                continue;
            }

            // Auto-generate summary from content if LLM didn't provide one
            if (summary.isBlank() && content.length() > 300) {
                summary = content.substring(0, Math.min(300, content.length())) + "...";
            }

            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("startMarker", startMarker);
            metadata.put("endMarker", endMarker);

            shards.add(new ContextShardStore.ContextShard(
                    id, "input-ctx", tags, contentType, content, summary, metadata, tokenEstimate));
        }
        return shards;
    }

    /** Extract content from originalInput between start and end markers. */
    private String extractContentBetweenMarkers(String original, String startMarker, String endMarker) {
        if (startMarker.isBlank() && endMarker.isBlank()) {
            return "";
        }
        int start = startMarker.isBlank() ? 0 : original.indexOf(startMarker);
        if (start < 0) return "";
        int end = endMarker.isBlank() ? original.length() : original.indexOf(endMarker, start);
        if (end < 0) end = original.length();
        else end += endMarker.length();
        return original.substring(start, Math.min(end, original.length()));
    }

    /**
     * Combine input and projectMeta into a structured document for LLM splitting.
     * Both sections are clearly labeled so the LLM can create meaningful shards
     * with appropriate tags (e.g. "user-request", "project-context", "sql-schema").
     */
    private String buildCombinedContentForSplit(String input, String projectMeta) {
        StringBuilder sb = new StringBuilder();
        if (!input.isBlank()) {
            sb.append("=== USER REQUEST ===\n");
            sb.append(input);
            sb.append("\n");
        }
        if (!projectMeta.isBlank()) {
            sb.append("\n=== PROJECT CONTEXT ===\n");
            sb.append(projectMeta);
            sb.append("\n");
        }
        return sb.toString();
    }

    /** Fallback: chunk the input into fixed-size pieces with sequential tags. */
    private void fallbackChunkAndSave(String input, String projectRootHash, Map<String, Object> updates) {
        int chunkSize = fallbackChunkSize();
        List<ContextShardStore.ContextShard> shards = new ArrayList<>();
        int offset = 0;
        int idx = 0;
        while (offset < input.length()) {
            int end = Math.min(offset + chunkSize, input.length());
            String chunk = input.substring(offset, end);
            shards.add(new ContextShardStore.ContextShard(
                    "shard_fallback_" + idx,
                    "input-ctx",
                    List.of("chunk-" + idx, "fallback-split"),
                    "text_chunk",
                    chunk,
                    Map.of("chunkIndex", idx, "offset", offset),
                    chunk.length() / 4
            ));
            offset = end;
            idx++;
        }
        if (!shards.isEmpty()) {
            String sourceId = "input-ctx-fallback-" + System.currentTimeMillis();
            shardStore.saveAll(projectRootHash, sourceId, shards).block();
            updates.put("contextSourceId", sourceId);
            updates.put("contextShardCount", shards.size());
            log.info("ContextSplitAction: fallback chunked into {} shards", shards.size());
        }
    }

    /** Route after contextSplit: always go to memoryLoad. */
    public String routeAfterContextSplit(OverAllState state) {
        return "memoryLoad";
    }
}
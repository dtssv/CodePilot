package io.codepilot.core.graph.actions;

import io.codepilot.core.graph.gather.InfoRequestDispatcher;
import io.codepilot.core.graph.gather.InfoRequestValidator;
import io.codepilot.core.sse.SseEvents;
import io.codepilot.core.graph.GraphSseHelper;
import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import java.util.*;
import java.util.concurrent.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Parallel gather node: executes multiple independent tool calls concurrently.
 *
 * <p>Mirrors Cursor's parallel tool execution where independent read-only
 * operations (reading files, searching code, checking diagnostics) are
 * executed in parallel to reduce latency.
 *
 * <h3>Execution Model:</h3>
 * <ol>
 *   <li>Classify requests into server-side and client-side</li>
 *   <li>Server-side requests executed concurrently via CompletableFuture</li>
 *   <li>Dependency-based batching: independent requests in parallel, dependent in sequence</li>
 *   <li>Client-side requests batched into a single SSE event</li>
 * </ol>
 */
@Component
public class ParallelGatherAction implements NodeAction {
    private static final Logger log = LoggerFactory.getLogger(ParallelGatherAction.class);
    private static final int MAX_CONCURRENT = 5;
    private static final long REQUEST_TIMEOUT_MS = 30_000;

    private final InfoRequestDispatcher dispatcher;
    private final InfoRequestValidator validator;
    private final ExecutorService executor;

    public ParallelGatherAction(InfoRequestDispatcher dispatcher, InfoRequestValidator validator) {
        this.dispatcher = dispatcher;
        this.validator = validator;
        this.executor = Executors.newFixedThreadPool(MAX_CONCURRENT, r -> {
            Thread t = new Thread(r, "parallel-gather");
            t.setDaemon(true);
            return t;
        });
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "parallel_gather");

        String phaseId = (String) state.value("phaseCursor").orElse("");
        var rawRequests = normalizeInfoRequests(state.value("infoRequests").orElse(List.of()));

        if (rawRequests.isEmpty()) {
            log.debug("ParallelGather: no info requests, skipping");
            updates.put("gatheredInfo", Map.of());
            return updates;
        }

        // 1. Validate
        List<Map<String, Object>> validRequests = new ArrayList<>();
        try {
            validator.validate(rawRequests);
            validRequests.addAll(rawRequests);
        } catch (IllegalArgumentException e) {
            log.warn("ParallelGather: validation failed: {}", e.getMessage());
        }

        // 2. Classify
        var dispatchResult = dispatcher.classify(validRequests);
        var serverRequests = dispatchResult.serverSide();
        var clientRequests = dispatchResult.clientSide();

        // 3. Build dependency-based execution batches
        List<List<Map<String, Object>>> executionBatches = buildExecutionBatches(serverRequests);

        // 4. Execute batches: within batch = parallel, between batches = sequential
        Map<String, Object> gatheredInfo = new ConcurrentHashMap<>();
        long startTime = System.currentTimeMillis();

        for (int batchIdx = 0; batchIdx < executionBatches.size(); batchIdx++) {
            List<Map<String, Object>> batch = executionBatches.get(batchIdx);
            log.info("ParallelGather: batch {} with {} requests", batchIdx, batch.size());

            List<CompletableFuture<Map<String, Object>>> futures = batch.stream()
                .map(req -> CompletableFuture.supplyAsync(() -> {
                    try {
                        var results = dispatcher.executeServerSide(List.of(req));
                        return results.isEmpty()
                            ? Map.of("id", req.getOrDefault("id", UUID.randomUUID().toString()), "result", "(empty)")
                            : results.get(0);
                    } catch (Exception e) {
                        log.warn("ParallelGather: request {} failed: {}", req.get("id"), e.getMessage());
                        return Map.of("id", req.getOrDefault("id", UUID.randomUUID().toString()), "error", e.getMessage());
                    }
                }, executor))
                .toList();

            try {
                CompletableFuture.allOf(futures.toArray(new CompletableFuture<?>[0]))
                    .get(REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            } catch (TimeoutException e) {
                log.warn("ParallelGather: batch {} timed out", batchIdx);
            } catch (Exception e) {
                log.warn("ParallelGather: batch {} error: {}", batchIdx, e.getMessage());
            }

            for (var future : futures) {
                try {
                    if (future.isDone()) {
                        var result = future.get();
                        String key = (String) result.getOrDefault("id", UUID.randomUUID().toString());
                        gatheredInfo.put(key, result);
                    }
                } catch (Exception ignored) {}
            }
        }

        // 5. Emit client-side requests as batch SSE
        if (!clientRequests.isEmpty()) {
            GraphSseHelper.emitEvent(state, SseEvents.GRAPH_INFO_REQUEST,
                Map.of("phaseId", phaseId, "requests", clientRequests, "parallel", true));
        }

        // 6. Track gather count
        int gatherCount = (int) state.value("gatherCount").orElse(0) + 1;
        updates.put("gatherCount", gatherCount);
        updates.put("gatheredInfo", gatheredInfo);
        updates.put("clientRequestsPending", !clientRequests.isEmpty());

        if (gatherCount > 10) {
            log.warn("ParallelGather: exceeded total gather budget (10)");
            updates.put("gatherExhausted", true);
        }

        long elapsed = System.currentTimeMillis() - startTime;
        log.info("ParallelGather: {} server + {} client in {}ms (gathers: {})",
            serverRequests.size(), clientRequests.size(), elapsed, gatherCount);
        return updates;
    }

    /**
     * Build execution batches based on dependencies between requests.
     * Independent requests go in batch 0 (fully parallel).
     * Dependent requests go in subsequent batches.
     */
    private List<List<Map<String, Object>>> buildExecutionBatches(List<Map<String, Object>> requests) {
        if (requests.size() <= 1) {
            return List.of(requests);
        }

        Map<String, Integer> requestIdToBatch = new HashMap<>();
        List<List<Map<String, Object>>> batches = new ArrayList<>();
        batches.add(new ArrayList<>());

        for (var req : requests) {
            String dependsOn = (String) req.get("dependsOn");
            String id = (String) req.getOrDefault("id", UUID.randomUUID().toString());
            if (dependsOn == null || dependsOn.isBlank()) {
                requestIdToBatch.put(id, 0);
                batches.get(0).add(req);
            } else {
                int depBatch = requestIdToBatch.getOrDefault(dependsOn, 0);
                int targetBatch = depBatch + 1;
                requestIdToBatch.put(id, targetBatch);
                while (batches.size() <= targetBatch) {
                    batches.add(new ArrayList<>());
                }
                batches.get(targetBatch).add(req);
            }
        }

        return batches;
    }

    /**
     * Normalizes raw infoRequests from graph state into a type-safe List of Maps.
     * Handles cases where LLM or Jackson deserialization produces String elements
     * instead of Map elements (e.g., ["fs.read", "code.outline"]).
     */
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> normalizeInfoRequests(Object raw) {
        if (raw == null) return List.of();
        if (!(raw instanceof List<?> list)) return List.of();

        List<Map<String, Object>> result = new ArrayList<>();
        for (Object item : list) {
            if (item instanceof Map<?, ?> map) {
                result.add((Map<String, Object>) map);
            } else if (item instanceof String kind) {
                log.warn("ParallelGather: normalizing string infoRequest '{}' to Map form", kind);
                result.add(Map.of("kind", (Object) kind, "id", UUID.randomUUID().toString()));
            } else {
                log.warn("ParallelGather: skipping unexpected infoRequest type: {}", item != null ? item.getClass() : "null");
            }
        }
        return result;
    }
}
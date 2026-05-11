package io.codepilot.core.graph.actions;

import io.codepilot.core.graph.gather.InfoRequestDispatcher;
import io.codepilot.core.sse.SseEvents;
import io.codepilot.core.graph.GraphSseHelper;
import com.alibaba.cloud.ai.graph.OverAllState;
import java.util.*;
import java.util.regex.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Tool Chain Orchestrator - executes a sequence of tool calls where the output
 * of one tool can be used as input to the next via ${stepId.field} substitution.
 *
 * <p>Mirrors Cursor's tool chain capability:
 * <pre>
 *   chain:
 *     - id: search1
 *       tool: fs.search
 *       args: { query: "UserService" }
 *     - id: read1
 *       tool: fs.read
 *       args: { path: "${search1.files[0].path}" }
 *       dependsOn: search1
 * </pre>
 */
@Component
public class ToolChainOrchestrator {
    private static final Logger log = LoggerFactory.getLogger(ToolChainOrchestrator.class);
    private static final Pattern VAR_PATTERN = Pattern.compile("\\$\\{([^.}]+)\\.([^.}]+)\\}");

    public Map<String, Object> executeChain(
            List<Map<String, Object>> steps,
            InfoRequestDispatcher dispatcher,
            OverAllState state) {

        Map<String, Object> results = new LinkedHashMap<>();
        List<List<Map<String, Object>>> batches = topologicalSort(steps);

        for (int batchIdx = 0; batchIdx < batches.size(); batchIdx++) {
            List<Map<String, Object>> batch = batches.get(batchIdx);
            log.info("ToolChain: batch {} with {} steps", batchIdx, batch.size());

            for (Map<String, Object> step : batch) {
                String stepId = (String) step.getOrDefault("id", UUID.randomUUID().toString());
                String tool = (String) step.get("tool");

                @SuppressWarnings("unchecked")
                Map<String, Object> rawArgs = (Map<String, Object>) step.getOrDefault("args", Map.of());
                Map<String, Object> resolvedArgs = resolveArgs(rawArgs, results);

                try {
                    var toolRequests = List.of(Map.of("id", stepId, "tool", tool, "args", resolvedArgs));
                    var dispatchResult = dispatcher.classify(toolRequests);
                    var serverResults = dispatcher.executeServerSide(dispatchResult.serverSide());

                    if (!serverResults.isEmpty()) {
                        results.put(stepId, serverResults.get(0));
                    } else if (!dispatchResult.clientSide().isEmpty()) {
                        GraphSseHelper.emitEvent(state, SseEvents.GRAPH_INFO_REQUEST,
                            Map.of("chainStepId", stepId, "requests", dispatchResult.clientSide()));
                        results.put(stepId, Map.of("_status", "client_pending"));
                    } else {
                        results.put(stepId, Map.of("_status", "empty"));
                    }
                    log.info("ToolChain: step {} ({}) completed", stepId, tool);
                } catch (Exception e) {
                    log.warn("ToolChain: step {} ({}) failed: {}", stepId, tool, e.getMessage());
                    results.put(stepId, Map.of("_error", e.getMessage(), "_status", "failed"));
                }
            }
        }
        return results;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> resolveArgs(Map<String, Object> args, Map<String, Object> results) {
        Map<String, Object> resolved = new LinkedHashMap<>();
        for (var entry : args.entrySet()) {
            Object value = entry.getValue();
            if (value instanceof String strValue) {
                resolved.put(entry.getKey(), resolveString(strValue, results));
            } else if (value instanceof Map) {
                resolved.put(entry.getKey(), resolveArgs((Map<String, Object>) value, results));
            } else if (value instanceof List<?> listValue) {
                List<Object> resolvedList = new ArrayList<>();
                for (Object item : listValue) {
                    if (item instanceof String strItem) resolvedList.add(resolveString(strItem, results));
                    else if (item instanceof Map) resolvedList.add(resolveArgs((Map<String, Object>) item, results));
                    else resolvedList.add(item);
                }
                resolved.put(entry.getKey(), resolvedList);
            } else {
                resolved.put(entry.getKey(), value);
            }
        }
        return resolved;
    }

    @SuppressWarnings("unchecked")
    private Object resolveString(String value, Map<String, Object> results) {
        Matcher matcher = VAR_PATTERN.matcher(value);
        if (!matcher.find()) return value;

        if (value.startsWith("${") && value.endsWith("}") && value.indexOf('$') == 0) {
            matcher.reset();
            if (matcher.matches()) {
                String stepId = matcher.group(1);
                String field = matcher.group(2);
                Object stepResult = results.get(stepId);
                if (stepResult instanceof Map) return ((Map<String, Object>) stepResult).get(field);
            }
        }

        StringBuffer sb = new StringBuffer();
        matcher.reset();
        while (matcher.find()) {
            String stepId = matcher.group(1);
            String field = matcher.group(2);
            Object stepResult = results.get(stepId);
            String replacement = "";
            if (stepResult instanceof Map) {
                Object fieldValue = ((Map<String, Object>) stepResult).get(field);
                replacement = fieldValue != null ? fieldValue.toString() : "";
            }
            matcher.appendReplacement(sb, Matcher.quoteReplacement(replacement));
        }
        matcher.appendTail(sb);
        return sb.toString();
    }

    private List<List<Map<String, Object>>> topologicalSort(List<Map<String, Object>> steps) {
        Map<String, Integer> stepLevel = new HashMap<>();
        for (var step : steps) {
            String id = (String) step.getOrDefault("id", UUID.randomUUID().toString());
            stepLevel.put(id, 0);
        }

        for (var step : steps) {
            String id = (String) step.getOrDefault("id", UUID.randomUUID().toString());
            String dependsOn = (String) step.get("dependsOn");
            if (dependsOn != null && !dependsOn.isBlank()) {
                int depLevel = stepLevel.getOrDefault(dependsOn, 0);
                stepLevel.put(id, Math.max(stepLevel.get(id), depLevel + 1));
            }
        }

        int maxLevel = stepLevel.values().stream().max(Integer::compare).orElse(0);
        List<List<Map<String, Object>>> batches = new ArrayList<>();
        for (int level = 0; level <= maxLevel; level++) {
            List<Map<String, Object>> batch = new ArrayList<>();
            for (var step : steps) {
                String id = (String) step.getOrDefault("id", UUID.randomUUID().toString());
                if (stepLevel.get(id) == level) batch.add(step);
            }
            if (!batch.isEmpty()) batches.add(batch);
        }
        return batches;
    }
}
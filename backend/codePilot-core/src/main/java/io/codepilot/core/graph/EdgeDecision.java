package io.codepilot.core.graph;

import java.util.List;
import java.util.Map;

/**
 * Edge decisions returned by each {@link GraphNode} to instruct
 * the {@link GraphOrchestrator} on what to do next.
 */
public sealed interface EdgeDecision {

    record Go(String nextNode) implements EdgeDecision {}

    record Retry(int attempt) implements EdgeDecision {}

    record Gather(List<Map<String, Object>> requests, String resumeTo) implements EdgeDecision {}

    record AskUser(Map<String, Object> needsInput, String nextNode) implements EdgeDecision {}

    record Await(String reason, String continuationToken) implements EdgeDecision {}

    record Done(String reason) implements EdgeDecision {}
}
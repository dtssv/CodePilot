package io.codepilot.core.graph;

import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Registry of all available {@link GraphNode} implementations.
 * Spring auto-discovers all beans implementing GraphNode and indexes them by id().
 */
@Component
public class GraphNodeRegistry {

    private final Map<String, GraphNode> nodes;

    public GraphNodeRegistry(List<GraphNode> nodeList) {
        this.nodes = nodeList.stream()
                .collect(Collectors.toMap(GraphNode::id, Function.identity()));
    }

    public GraphNode get(String nodeId) {
        return nodes.get(nodeId);
    }

    public boolean has(String nodeId) {
        return nodes.containsKey(nodeId);
    }
}
package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphSseHelper;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Component;
import java.util.*;

/** Generate node: LLM produces toolCalls/patches for the current phase, or infoRequests. */
@Component
public class GenerateAction implements NodeAction<OverAllState> {

    private final ChatClient chatClient;

    public GenerateAction(ChatClient chatClient) {
        this.chatClient = chatClient;
    }

    @Override
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "generate");
        // TODO: invoke chatClient with graph.generate(phase) prompt
        // Parse: infoRequests[] → "gather", toolCalls[] → "applyPatch"
        GraphSseHelper.emitEvent(state, "graph_transition",
                Map.of("from", "preCheck", "to", "generate", "phaseId", state.value("phaseCursor").orElse("")));
        updates.put("generateResult", "toolCalls"); // or "infoRequests" or "askUser"
        return updates;
    }

    public String routeAfterGenerate(OverAllState state) {
        String result = (String) state.value("generateResult").orElse("toolCalls");
        return switch (result) {
            case "infoRequests" -> "gather";
            case "askUser" -> "askUser";
            default -> "applyPatch";
        };
    }
}
package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.sse.SseEvents;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Synthesize node for Deep Research graph template.
 *
 * <p>After all sub-questions have been researched (all phases committed),
 * this node takes the entire {@code state.gathered[]} and produces a
 * comprehensive research report via LLM.
 *
 * <p>The report is emitted as a streaming {@code delta} event so the user
 * sees it being generated in real-time, just like a normal chat response.
 */
@Component
public class SynthesizeAction implements NodeAction {

    private final ChatClient chatClient;

    public SynthesizeAction(ChatClient chatClient) {
        this.chatClient = chatClient;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "synthesize");

        var gathered = (List<Map<String, Object>>) state.value("gathered").orElse(List.of());
        String goal = (String) state.value("input").orElse("");

        // TODO: invoke chatClient with deep-research synthesize prompt
        // Prompt: "Based on the following research findings, produce a comprehensive report for: {goal}"
        // Include gathered info summaries as context

        // Placeholder: produce a summary delta
        String report = "## Research Report\n\nBased on the gathered information (" + gathered.size()
            + " sources), here is the synthesized analysis for: " + goal;

        // Emit as delta (streamed to user like normal chat response)
        GraphSseHelper.emitEvent(state, "delta", Map.of("text", report));

        // Update user plan: mark synthesize step as completed
        GraphSseHelper.emitEvent(state, SseEvents.USER_PLAN_PROGRESS,
            Map.of("stepId", "synthesize", "status", "completed",
                   "message", "Research report generated"));

        updates.put("doneReason", "final");
        return updates;
    }
}
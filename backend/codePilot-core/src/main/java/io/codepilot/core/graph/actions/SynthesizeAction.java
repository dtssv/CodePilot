package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.graph.GraphLlmHelper;
import io.codepilot.core.model.ChatClientFactory;
import io.codepilot.core.model.ModelSource;
import io.codepilot.core.sse.SseEvents;
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

    private final ChatClientFactory chatClientFactory;

    public SynthesizeAction(ChatClientFactory chatClientFactory) {
        this.chatClientFactory = chatClientFactory;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "synthesize");

        var gathered = (List<Map<String, Object>>) state.value("gathered").orElse(List.of());
        String goal = (String) state.value("input").orElse("");

        // 1) Build synthesized report prompt
        StringBuilder evidence = new StringBuilder();
        evidence.append("[GATHERED EVIDENCE — ").append(gathered.size()).append(" items]\n");
        for (int i = 0; i < Math.min(gathered.size(), 30); i++) {
            Map<String, Object> e = gathered.get(i);
            String kind = String.valueOf(e.getOrDefault("kind", "unknown"));
            String id = String.valueOf(e.getOrDefault("id", ""));
            Object result = e.get("result");
            String resultStr = result != null ? result.toString() : "";
            if (resultStr.length() > 400) resultStr = resultStr.substring(0, 400) + "...";
            evidence.append("- (").append(kind).append(")");
            if (!id.isBlank() && !"null".equals(id)) evidence.append(" id=").append(id);
            if (!resultStr.isBlank()) evidence.append(": ").append(resultStr);
            evidence.append("\n");
        }
        if (gathered.size() > 30) evidence.append("... (truncated)\n");

        String prompt =
            "You are the synthesizer for a deep-research workflow.\n"
                + "Overall task/goal:\n"
                + goal
                + "\n\nNow synthesize a comprehensive, actionable research report.\n"
                + "Requirements:\n"
                + "- Focus on answering the user's goal.\n"
                + "- Use the gathered evidence as the only factual basis.\n"
                + "- Clearly separate claims from evidence when possible.\n"
                + "- Output in markdown with: Summary, Findings, Recommendations, and any Open Questions.\n"
                + "\n" + evidence + "\n"
                + "Return ONLY the markdown report text.\n";

        // 2) Call LLM and emit as delta
        String modelId = (String) state.value("modelId").orElse(null);
        String modelSourceName = (String) state.value("modelSource").orElse(null);
        ModelSource modelSource =
            modelSourceName != null ? ModelSource.valueOf(modelSourceName) : null;
        String userId = (String) state.value("userId").orElse(null);

        var resolved = chatClientFactory.resolve(modelId, modelSource, userId);
        String report = GraphLlmHelper.completeUserPrompt(resolved, state, prompt);

        GraphSseHelper.emitEvent(state, "delta", Map.of("text", report));

        // Update user plan: mark synthesize step as completed
        GraphSseHelper.emitEvent(state, SseEvents.USER_PLAN_PROGRESS,
            Map.of("stepId", "synthesize", "status", "completed",
                   "message", "Research report generated"));
        return updates;
    }
}
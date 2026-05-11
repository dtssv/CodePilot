package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.sse.SseEvents;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Search-Evaluate node for Deep Research graph template.
 *
 * <p>After each Gather round, this node asks the LLM to evaluate whether the
 * collected information is sufficient to answer the current research sub-question.
 *
 * <p>Possible outcomes (written to state["evaluateResult"]):
 * <ul>
 *   <li>{@code "sufficient"} → proceed to commit (move to next sub-question or synthesize)</li>
 *   <li>{@code "insufficient"} → generate more search queries and gather again</li>
 *   <li>{@code "askUser"} → ambiguous, need user clarification</li>
 * </ul>
 */
@Component
public class SearchEvaluateAction implements NodeAction {

    private static final int MAX_SEARCH_ROUNDS = 5;
    private final ChatClient chatClient;

    public SearchEvaluateAction(ChatClient chatClient) {
        this.chatClient = chatClient;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "searchEvaluate");

        String phaseId = (String) state.value("phaseCursor").orElse("");
        var gathered = (List<?>) state.value("gathered").orElse(List.of());
        int searchRound = (int) state.value("searchRound").orElse(0);

        // TODO: invoke chatClient with deep-research evaluate prompt
        // Prompt should include: sub-question, gathered info summary, ask LLM if enough
        // Placeholder: sufficient if gathered has items, or max rounds reached

        if (searchRound >= MAX_SEARCH_ROUNDS) {
            // Force move on — enough rounds spent
            GraphSseHelper.emitEvent(state, SseEvents.USER_PLAN_PROGRESS,
                Map.of("stepId", phaseId, "status", "completed",
                       "message", "Search completed (max rounds reached)"));
            updates.put("evaluateResult", "sufficient");
            return updates;
        }

        boolean hasMeaningfulData = !gathered.isEmpty();
        // Placeholder logic — real impl should use LLM to judge
        updates.put("evaluateResult", hasMeaningfulData ? "sufficient" : "insufficient");

        if (hasMeaningfulData) {
            GraphSseHelper.emitEvent(state, SseEvents.USER_PLAN_PROGRESS,
                Map.of("stepId", phaseId, "status", "completed",
                       "message", "Sufficient information gathered"));
        }
        return updates;
    }

    public String routeAfterEvaluate(OverAllState state) {
        String result = (String) state.value("evaluateResult").orElse("sufficient");
        return switch (result) {
            case "insufficient" -> "generate";   // back to generate more queries
            case "askUser" -> "askUser";
            default -> "commit";                  // sufficient → next sub-question
        };
    }
}
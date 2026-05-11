package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.sse.SseEvents;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Planning node: produces TWO layers of plan from LLM output:
 *
 * <h3>Layer 1 — User Plan (stable, user-facing)</h3>
 * <p>High-level steps shown in the Plan panel. Emitted as {@code user_plan} SSE event.
 * Once produced it rarely changes — only progress status is updated by CommitAction/RepairAction.
 * Example: "1. 添加幂等校验逻辑  2. 编写单元测试  3. 更新 README"</p>
 *
 * <h3>Layer 2 — Execution Phases (dynamic, graph-internal)</h3>
 * <p>Detailed phases[] that drive the Graph engine's PhaseLoop (PreCheck→Generate→Verify→...).
 * Emitted as {@code graph_plan} SSE event. May be re-planned by the Repair node or
 * adjusted during execution. User doesn't need to see phase-level detail.</p>
 *
 * <p>The LLM is prompted to return a JSON with both {@code userPlan} and {@code phases[]}
 * in a single response. If LLM needs more info first, it returns {@code infoRequests[]}
 * instead, triggering a Gather→Reenter→Planning loop.</p>
 */
@Component
public class PlanningAction implements NodeAction<OverAllState> {

    private final ChatClient chatClient;

    public PlanningAction(ChatClient chatClient) {
        this.chatClient = chatClient;
    }

    @Override
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "planning");

        // TODO: invoke chatClient with prompt.graph.planning template
        // Expected LLM response JSON:
        // {
        //   "userPlan": { "goal":"...", "summary":"...", "steps":[{"id":"s1","title":"...","description":"..."}] },
        //   "phases": [ { "id":"p1", "title":"...", "entry":[...], "exit":[...], "budget":{...} } ],
        //   "infoRequests": null  // or [...] if needs more info
        // }

        // ── Placeholder: simulate LLM producing both plans ──

        // Layer 1: User Plan (stable, shown to user)
        // For deep-research: steps are sub-questions + final synthesis
        // For code-gen: steps are implementation phases
        String mode = (String) state.value("mode").orElse("AGENT");
        String input = (String) state.value("input").orElse("");

        // TODO: invoke chatClient — LLM returns both userPlan and phases
        // Placeholder below simulates different plans per template

        List<Map<String, Object>> userSteps;
        List<Map<String, Object>> phases;

        // Detect deep-research (either via graphTemplate in state, or input pattern)
        boolean isDeepResearch = "deep-research".equals(state.value("graphTemplate").orElse(""));

        if (isDeepResearch) {
            // Deep Research: sub-questions as steps + final synthesis
            userSteps = List.of(
                Map.of("id", "q1", "index", 1, "title", "Researching sub-question 1", "description", "Searching and analyzing", "status", "in_progress"),
                Map.of("id", "q2", "index", 2, "title", "Researching sub-question 2", "description", "Searching and analyzing", "status", "pending"),
                Map.of("id", "synthesize", "index", 3, "title", "Generating research report", "description", "Synthesizing findings", "status", "pending")
            );
            phases = List.of(
                Map.of("id", "q1", "title", "Research sub-question 1", "intent", "search", "budget", Map.of("searchRounds", 5)),
                Map.of("id", "q2", "title", "Research sub-question 2", "intent", "search", "budget", Map.of("searchRounds", 5))
            );
        } else {
            // Default code-gen template
            userSteps = List.of(
                Map.of("id", "s1", "index", 1, "title", "Implementing changes", "description", "Code generation", "status", "in_progress")
            );
            phases = List.of(
                Map.of("id", "p1", "title", "Implementation", "intent", "code-change",
                       "entry", List.of(), "exit", List.of(), "budget", Map.of("attempts", 3))
            );
        }

        var userPlan = Map.of(
            "goal", input,
            "summary", isDeepResearch ? "Researching your question in depth" : "Executing your request in phases",
            "steps", userSteps,
            "status", "in_progress"
        );
        GraphSseHelper.emitEvent(state, SseEvents.USER_PLAN, userPlan);
        updates.put("userPlan", userPlan);

        // Layer 2: Execution Phases
        GraphSseHelper.emitEvent(state, SseEvents.GRAPH_PLAN,
            Map.of("phases", phases, "graphId", "gph-" + UUID.randomUUID().toString().substring(0, 8)));
        updates.put("phases", phases);
        updates.put("phaseCursor", (String) phases.get(0).get("id"));

        // Route decision
        updates.put("planningResult", "phases");  // or "infoRequests" or "error"
        return updates;
    }

    /**
     * Conditional edge router: determines next node after planning.
     */
    public String routeAfterPlanning(OverAllState state) {
        String result = (String) state.value("planningResult").orElse("phases");
        return switch (result) {
            case "infoRequests" -> "gather";
            case "error" -> "finalize";
            default -> "preCheck";
        };
    }
}
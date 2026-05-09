package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.dto.ConversationRunRequest;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Intake node action: initializes the graph state from the conversation request.
 * Normalizes answers, loads lastPlan/ledger, sets up session context.
 */
@Component
public class IntakeAction implements NodeAction<OverAllState> {

    @Override
    public Map<String, Object> apply(OverAllState state) {
        // Intake just passes through — real initialization done in buildInitialState
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "intake");
        return updates;
    }

    /**
     * Builds the initial OverAllState from the request payload.
     * Called by GraphEngineService before graph.invoke().
     */
    public OverAllState buildInitialState(ConversationRunRequest req) {
        var initial = new HashMap<String, Object>();
        initial.put("sessionId", req.sessionId());
        initial.put("input", req.input());
        initial.put("mode", req.mode().name());
        initial.put("intent", req.intent() != null ? req.intent().name() : "NEW");
        initial.put("modelId", req.modelId());
        initial.put("currentNode", "intake");
        initial.put("phaseCursor", "");
        initial.put("phases", new ArrayList<>());
        initial.put("attempts", new HashMap<String, Integer>());
        initial.put("gathered", new ArrayList<>());
        initial.put("sseEvents", new ArrayList<Map<String, Object>>());
        initial.put("gatherResumeTo", "");
        initial.put("gatherLoopCount", 0);
        initial.put("doneReason", "final");

        // Carry over answers if intent=answer
        if (req.answers() != null) {
            initial.put("answers", req.answers());
        }

        // Carry over graphState from plugin for resume
        if (req.graphState() != null) {
            initial.putAll(req.graphState());
        }

        return new OverAllState(initial);
    }
}
package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import com.alibaba.cloud.ai.graph.state.strategy.ReplaceStrategy;
import io.codepilot.core.dto.ConversationRunRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Intake node action: initializes the graph state from the conversation request.
 * Normalizes answers, loads lastPlan/ledger, sets up session context.
 */
@Component
public class IntakeAction implements NodeAction {

    private static final Logger log = LoggerFactory.getLogger(IntakeAction.class);

    /**
     * Creates an empty OverAllState with ReplaceStrategy registered for all known keys.
     * Used as the StateGraph factory so that the framework's internal overAllState
     * has the correct keyStrategies from the start.
     */
    public static OverAllState createStateWithStrategies() {
        var state = new OverAllState();
        STATE_KEYS.forEach(key -> state.registerKeyAndStrategy(key, new ReplaceStrategy()));
        return state;
    }

    /** All keys used in graph state — must be registered as keyStrategies so that
     *  the framework's input() and updateState() don't silently drop them. */
    private static final List<String> STATE_KEYS = List.of(
            "sessionId", "input", "mode", "intent",
            "modelId", "modelSource", "userId",
            "currentNode", "phaseCursor", "phases",
            "attempts", "gathered", "sseEvents",
            "gatherResumeTo", "gatherLoopCount", "doneReason",
            "answers", "graphTemplate",
            // planning outputs
            "userPlan", "planningResult",
            // preCheck outputs
            "preCheckPassed", "preCheckResult", "preCheckInfoRequests",
            "completedPhases", "modifiedFiles", "existingFiles",
            // generate outputs
            "generateResult", "pendingPatches",
            // applyPatch outputs
            "patchResult", "patchResults", "patchErrors",
            "appliedCount", "failedCount", "shadowValidationErrors",
            // verify outputs
            "verifyReport", "verifyResult",
            "clientDiagnostics", "testResults", "lintResults",
            // repair outputs
            "repairResult", "askUserQuestion",
            "phaseOriginalCode", "appliedPatches",
            "graphVerifyPolicy", "graphRepairPolicy", "graphGatherPolicy",
            // gather outputs
            "gatheredInfo", "infoRequests",
            // commit outputs
            "commitResult", "hasNextPhase",
            // finalize outputs
            "donePayload", "sessionDigest", "summaryForNextTurn",
            "completedToolCalls", "taskLedger",
            // search-evaluate / synthesize
            "searchEvaluateResult", "synthesizeResult"
    );

    @Override
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "intake");

        // Carry over modelId, modelSource and userId so they survive across graph iterations.
        state.<String>value("modelId").ifPresent(v -> updates.put("modelId", v));
        state.<String>value("modelSource").ifPresent(v -> updates.put("modelSource", v));
        state.<String>value("userId").ifPresent(v -> updates.put("userId", v));

        log.info("IntakeAction state keys={}, modelId={}, modelSource={}, userId={}, keyStrategies={}",
            state.data().keySet(),
            state.value("modelId").orElse(null),
            state.value("modelSource").orElse(null),
            state.value("userId").orElse(null),
            state.keyStrategies().keySet());
        return updates;
    }

    /**
     * Builds the initial OverAllState from the request payload.
     * Called by GraphEngineService before graph.invoke().
     *
     * <p>Registers a {@link ReplaceStrategy} for every known state key so that the
     * graph framework's {@code input()} and {@code updateState()} methods don't
     * silently discard values whose keys are absent from {@code keyStrategies}.
     * This was the root cause of modelId/modelSource being lost mid-graph.
     */
    public OverAllState buildInitialState(ConversationRunRequest req, String userId) {
        var initial = new HashMap<String, Object>();
        initial.put("sessionId", req.sessionId());
        initial.put("input", req.input());
        initial.put("mode", req.mode().name());
        initial.put("intent", req.intent() != null ? req.intent().name() : "NEW");
        initial.put("modelId", req.modelId());
        initial.put("modelSource", req.modelSource() != null ? req.modelSource().name() : null);
        initial.put("userId", userId);
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

        var state = new OverAllState(initial);
        // Register ReplaceStrategy for every known key so input() and updateState()
        // won't filter them out. Without this, modelId/modelSource (and all other
        // state) are silently dropped because new StateGraph(OverAllState::new)
        // creates a state with an empty keyStrategies map.
        STATE_KEYS.forEach(key -> state.registerKeyAndStrategy(key, new ReplaceStrategy()));
        log.info("buildInitialState result: modelId={}, modelSource={}, userId={}, dataKeys={}, strategyKeys={}",
            state.value("modelId").orElse("NULL"),
            state.value("modelSource").orElse("NULL"),
            state.value("userId").orElse("NULL"),
            state.data().keySet(),
            state.keyStrategies().keySet());
        return state;
    }
}
package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import com.alibaba.cloud.ai.graph.state.strategy.ReplaceStrategy;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.graph.GraphCheckpointStore;
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
            "repairResult", "askUserQuestion", "repairToolCalls",
            "phaseOriginalCode", "appliedPatches",
            "graphVerifyPolicy", "graphRepairPolicy", "graphGatherPolicy",
            // gather outputs
            "gatheredInfo", "infoRequests",
            // commit outputs
            "commitResult", "hasNextPhase",
            // fast-path
            "fastPathEnabled",
            // finalize outputs
            "donePayload", "sessionDigest", "summaryForNextTurn",
            "completedToolCalls", "taskLedger",
            // search-evaluate / synthesize
            "searchEvaluateResult", "synthesizeResult",
            // ── Interrupt-resume keys (previously missing) ──
            "awaiting", "continuationToken", "askUserOrigin", "askUserTitle",
            "pendingQuestions", "clientRequestsPending", "gatherCount",
            "gatherExhausted", "verifyReportRaw", "resumeNextNode"
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
     * Route after intake: determines the next node based on whether this is
     * a fresh run or a resume from a checkpoint.
     *
     * <p>For fresh runs, routes to "planning" as usual.
     * For resume runs (state has "resumeNextNode"), routes directly to the
     * checkpoint's target node, skipping the intake→planning preamble.
     */
    public String routeAfterIntake(OverAllState state) {
        String resumeNextNode = (String) state.value("resumeNextNode").orElse("");
        if (!resumeNextNode.isBlank()) {
            // Resume mode: jump directly to the checkpoint's next node
            log.info("IntakeAction route: resume mode, jumping to nextNode={}", resumeNextNode);
            // Validate that the target node is a valid graph node
            return switch (resumeNextNode) {
                case "planning", "preCheck", "generate", "applyPatch", "repair",
                     "gather", "askUser", "verify", "commit" -> resumeNextNode;
                default -> {
                    log.warn("IntakeAction route: invalid resumeNextNode={}, falling back to planning", resumeNextNode);
                    yield "planning";
                }
            };
        }
        // Fresh run: proceed to planning
        return "planning";
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

    /**
     * Restores OverAllState from a checkpoint snapshot for resume execution.
     *
     * <p>Merges the saved state data with any new data from the resume request
     * (answers, graphState overrides). This is the core of the interrupt-resume
     * mechanism: the graph continues from where it left off with the user's
     * answers injected into state.
     *
     * @param snapshot the checkpoint loaded from Redis
     * @param req      the resume request with answers and optional graphState
     * @param userId   the user ID
     * @return restored OverAllState ready for graph.invoke()
     */
    public static OverAllState restoreFromCheckpoint(
            GraphCheckpointStore.CheckpointSnapshot snapshot,
            ConversationRunRequest req,
            String userId) {

        // Start with the saved state data
        var restored = new HashMap<>(snapshot.stateData());

        // Override sessionId and userId from the resume request
        restored.put("sessionId", req.sessionId());
        restored.put("userId", userId);

        // Inject user answers from the resume request
        if (req.answers() != null && !req.answers().isEmpty()) {
            restored.put("answers", req.answers());
        }

        // Carry over modelId/modelSource
        if (req.modelId() != null) {
            restored.put("modelId", req.modelId());
        }
        if (req.modelSource() != null) {
            restored.put("modelSource", req.modelSource().name());
        }

        // Merge any additional graphState from the plugin
        if (req.graphState() != null) {
            restored.putAll(req.graphState());
        }

        // Set currentNode to the nextNode from the checkpoint (where to resume from)
        restored.put("currentNode", snapshot.nextNode());

        // Set resumeNextNode so IntakeAction's routeAfterIntake() can jump directly
        // to the target node, bypassing the intake→planning preamble
        restored.put("resumeNextNode", snapshot.nextNode());

        // Clear doneReason so the graph doesn't immediately terminate
        restored.remove("doneReason");

        var state = new OverAllState(restored);
        STATE_KEYS.forEach(key -> state.registerKeyAndStrategy(key, new ReplaceStrategy()));

        log.info("restoreFromCheckpoint: nextNode={}, stateKeys={}, hasAnswers={}",
                snapshot.nextNode(), state.data().keySet(),
                req.answers() != null ? req.answers().size() : 0);

        return state;
    }
}
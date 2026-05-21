package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.KeyStrategy;
import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import com.alibaba.cloud.ai.graph.state.strategy.ReplaceStrategy;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.dto.ConversationRunRequest.Intent;
import io.codepilot.core.graph.GraphCheckpointStore;
import io.codepilot.core.graph.GraphExecutionLog;
import io.codepilot.core.graph.IntakeIntent;
import io.codepilot.core.graph.IntakeIntentClassifier;
import io.codepilot.core.graph.ProjectMetaHelper;
import io.codepilot.core.graph.StuckStepRecovery;
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

    private final IntakeIntentClassifier intakeIntentClassifier;

    public IntakeAction(IntakeIntentClassifier intakeIntentClassifier) {
        this.intakeIntentClassifier = intakeIntentClassifier;
    }

    /**
     * Key strategies for all graph state fields (Spring AI Alibaba Graph 1.1+ {@code StateGraph} factory).
     */
    public static Map<String, KeyStrategy> keyStrategies() {
        Map<String, KeyStrategy> strategies = new LinkedHashMap<>();
        STATE_KEYS.forEach(key -> strategies.put(key, new ReplaceStrategy()));
        return strategies;
    }

    /** All keys used in graph state — must be registered as keyStrategies so that
     *  the framework's input() and updateState() don't silently drop them. */
    private static final List<String> STATE_KEYS = List.of(
            "sessionId", "input", "mode", "intent",
            "modelId", "modelSource", "userId", "projectMeta",
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
            "repairResult", "repairContext", "askUserQuestion", "repairToolCalls", "repairRetryToolCalls",
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
            "gatherExhausted", "verifyReportRaw", "resumeNextNode",
            // ── MCP integration keys ──
            "mcpTools",
            // ── Skill per-node matching ──
            "userSkillRefs", "userSkillBodies", "skillsConfig", "activeSkillIds",
            // ── Conversation history for multi-turn context ──
            "conversationHistory",
            // ── Max / thinking policy (propagated to graph LLM calls) ──
            "maxMode", "thinkingMode", "maxOutputTokens",
            // ── Conversational Q&A (skip planning) ──
            "conversationalOnly",
            "planningProseStreamed",
            "requireFileGather",
            "allowShellExec",
            "directToolRound",
            "phaseToolsHadFailure",
            "phaseFailureRetries",
            "phaseCommitBlocked",
            "sessionHadSuccessfulCompile",
            "sessionHadSuccessfulRun",
            "sessionExecutionFacts",
            "graphExecutionJournal",
            "overallGoalUnmet",
            "intakeIntent",
            "needsTools",
            "needsPlanning",
            "intakeSuggestedTools",
            "toolApproachHistory",
            "toolApproachesAttempted",
            "toolApproachExhausted",
            "approachEscalationDone",
            "approachRepeatBlocked",
            "sessionHasSourceReads",
            "sessionHasAnalysisOutput",
            "phaseHasAnalysisOutput",
            "phaseGeneratePasses",
            "allowWrittenFileOverwrite",
            // ── Intent dispatch (lightweight path routing) ──
            "dispatchPath"
    );

    /** Execution keys that must not carry over from a prior run when intent is NEW. */
    private static final List<String> STALE_EXECUTION_KEYS =
            List.of(
                    "gatheredInfo",
                    "phaseHasAnalysisOutput",
                    "sessionHasSourceReads",
                    "sessionHasAnalysisOutput",
                    "sessionExecutionFacts",
                    "graphExecutionJournal",
                    "repairContext",
                    "completedPhases",
                    "phaseToolsHadFailure",
                    "phaseCommitBlocked",
                    "phaseGeneratePasses",
                    "toolApproachHistory",
                    "toolApproachesAttempted",
                    "toolApproachExhausted",
                    "approachEscalationDone",
                    "approachRepeatBlocked",
                    "pendingPatches",
                    "generateResult",
                    "patchResult",
                    "patchResults",
                    "allowWrittenFileOverwrite",
                    "userPlan",
                    "phases",
                    "phaseCursor",
                    "planningResult",
                    "completedToolCalls");

    @Override
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "intake");
        GraphExecutionLog.nodeEnter(state, "intake");

        // Carry over modelId, modelSource and userId so they survive across graph iterations.
        state.<String>value("modelId").ifPresent(v -> updates.put("modelId", v));
        state.<String>value("modelSource").ifPresent(v -> updates.put("modelSource", v));
        state.<String>value("userId").ifPresent(v -> updates.put("userId", v));
        // Carry over projectMeta so it survives across graph iterations.
        state.<String>value("projectMeta").ifPresent(v -> updates.put("projectMeta", v));

        String input = (String) state.value("input").orElse("");
        String mode = (String) state.value("mode").orElse("AGENT");
        String resumeNextNode = (String) state.value("resumeNextNode").orElse("");

        if (resumeNextNode.isBlank() && !input.isBlank()) {
            IntakeIntent intent = intakeIntentClassifier.classify(state, input, mode);
            updates.put("intakeIntent", intent.toMap());
            updates.put("needsTools", intent.needsTools());
            updates.put("needsPlanning", intent.needsPlanning());
            updates.put("intakeSuggestedTools", intent.toolsAsMaps());
            updates.put("dispatchPath", intent.dispatchPath().name());

            if (intent.requireFileGather()) {
                updates.put("requireFileGather", true);
            }
            if (intent.allowShellExec()) {
                updates.put("allowShellExec", true);
            }
            if (intent.allowShellExec() && intent.needsPlanning()) {
                updates.put("workflowCompileRun", true);
            }
            if (intent.conversationalOnly()) {
                updates.put("conversationalOnly", true);
                updates.put("skipPlan", true);
                List<Map<String, Object>> phases =
                        List.of(
                                Map.of(
                                        "id",
                                        "p1",
                                        "title",
                                        "Answer",
                                        "intent",
                                        "text",
                                        "entry",
                                        List.of(),
                                        "exit",
                                        List.of(),
                                        "budget",
                                        Map.of("attempts", 1)));
                updates.put("phases", phases);
                updates.put("phaseCursor", "p1");
                updates.put("fastPathEnabled", true);
                log.info("IntakeAction: dispatchPath={}, conversationalOnly={}",
                        intent.dispatchPath(), intent.conversationalOnly());
            }
        }

        log.info("IntakeAction state keys={}, modelId={}, modelSource={}, userId={}, keyStrategies={}",
            state.data().keySet(),
            state.value("modelId").orElse(null),
            state.value("modelSource").orElse(null),
            state.value("userId").orElse(null),
            state.keyStrategies().keySet());
        GraphExecutionLog.nodeExit(state, "intake", updates);
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

        // ★ Determine if planning is needed based on mode
        String mode = (String) state.value("mode").orElse("AGENT");

        // CHAT mode: skip planning, go directly to generate
        if ("CHAT".equalsIgnoreCase(mode)) {
            log.info("IntakeAction route: CHAT mode, skipping planning → generate");
            return "generate";
        }

        if (Boolean.TRUE.equals(state.value("conversationalOnly").orElse(false))) {
            log.info("IntakeAction route: direct answer → intentDispatch (conversational shortcut)");
            return "intentDispatch";
        }

        // Check dispatchPath from intake intent classification
        @SuppressWarnings("unchecked")
        Map<String, Object> intakeIntent =
                (Map<String, Object>) state.value("intakeIntent").orElse(Map.of());
        String dispatchPathStr =
                String.valueOf(intakeIntent.getOrDefault("dispatchPath", ""));
        if ("MCP_DIRECT".equals(dispatchPathStr)) {
            log.info("IntakeAction route: MCP tool direct → intentDispatch");
            return "intentDispatch";
        }
        if ("SKILL_DIRECT".equals(dispatchPathStr)) {
            log.info("IntakeAction route: Skill direct → intentDispatch");
            return "intentDispatch";
        }
        if ("CONVERSATIONAL".equals(dispatchPathStr)) {
            log.info("IntakeAction route: conversational → intentDispatch");
            return "intentDispatch";
        }

        boolean needsTools = Boolean.TRUE.equals(state.value("needsTools").orElse(false));
        boolean needsPlanning = Boolean.TRUE.equals(state.value("needsPlanning").orElse(true));
        if (needsTools && !needsPlanning) {
            log.info("IntakeAction route: tool-first (no multi-step plan) → generate");
            return "generate";
        }

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
        initial.put("projectMeta", req.projectMeta() != null ? req.projectMeta() : "");
        initial.put("currentNode", "intake");
        initial.put("phaseCursor", "");
        initial.put("phases", new ArrayList<>());
        initial.put("attempts", new HashMap<String, Integer>());
        initial.put("gathered", new ArrayList<>());
        initial.put("sseEvents", new ArrayList<Map<String, Object>>());
        initial.put("gatherResumeTo", "");
        initial.put("gatherLoopCount", 0);
        initial.put("doneReason", "final");
        if (req.policy() != null) {
            initial.put("maxMode", Boolean.TRUE.equals(req.policy().maxMode()));
            if (req.policy().thinkingMode() != null) {
                initial.put("thinkingMode", req.policy().thinkingMode());
            }
            if (req.policy().maxOutputTokens() != null) {
                initial.put("maxOutputTokens", req.policy().maxOutputTokens());
            }
        }

        // ★ Store conversation history from contexts.recent for multi-turn context
        // This allows GenerateAction and PlanningAction to include previous turns
        // when building LLM prompts, enabling true multi-turn conversation.
        // Convert RecentMessage records to Map<String, String> so downstream consumers
        // can safely cast to List<Map<String, String>> without ClassCastException.
        if (req.contexts() != null && req.contexts().recent() != null && !req.contexts().recent().isEmpty()) {
            var historyMaps = req.contexts().recent().stream()
                .map(m -> {
                    var map = new java.util.LinkedHashMap<String, String>();
                    map.put("role", m.role());
                    map.put("content", m.content());
                    if (m.summary() != null) map.put("summary", m.summary());
                    if (m.seq() != null) map.put("seq", String.valueOf(m.seq()));
                    return map;
                })
                .toList();
            initial.put("conversationHistory", historyMaps);
        } else {
            initial.put("conversationHistory", List.of());
        }

        // Carry over answers if intent=answer
        if (req.answers() != null) {
            initial.put("answers", req.answers());
        }

        // Carry over graphState from plugin for resume
        if (req.graphState() != null) {
            initial.putAll(req.graphState());
        }

        // ★ After merging graphState, re-apply request fields that must take precedence
        // over any stale values in the saved graphState.
        // The user's current input, intent, and answers should always override saved state.
        initial.put("input", req.input());
        initial.put("intent", req.intent() != null ? req.intent().name() : "NEW");
        initial.put("sessionId", req.sessionId());
        initial.put("mode", req.mode().name());
        if (req.answers() != null) {
            initial.put("answers", req.answers());
        }

        if (req.intent() == Intent.NEW) {
            clearStaleExecutionState(initial);
        }
        ProjectMetaHelper.seedFromProjectMeta(initial);
        // ★ MCP tool metadata for prompts (execution is client-side via gather / tool_call)
        if (req.mcpTools() != null && !req.mcpTools().isEmpty()) {
            initial.put("mcpTools", req.mcpTools());
        }

        if (req.userSkillRefs() != null && !req.userSkillRefs().isEmpty()) {
            initial.put("userSkillRefs", req.userSkillRefs());
        }
        if (req.userSkillBodies() != null && !req.userSkillBodies().isEmpty()) {
            initial.put("userSkillBodies", req.userSkillBodies());
        }
        if (req.skills() != null) {
            var skillsCfg = new java.util.LinkedHashMap<String, Object>();
            if (req.skills().requested() != null) {
                skillsCfg.put("requested", req.skills().requested());
            }
            if (req.skills().disabled() != null) {
                skillsCfg.put("disabled", req.skills().disabled());
            }
            if (!skillsCfg.isEmpty()) {
                initial.put("skillsConfig", skillsCfg);
            }
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

    /** Drop per-run execution state inherited from plugin graphState on a fresh conversation. */
    static void clearStaleExecutionState(Map<String, Object> state) {
        for (String key : STALE_EXECUTION_KEYS) {
            state.remove(key);
        }
        state.put("gatheredInfo", Map.of());
        state.put("phaseCursor", "");
        state.put("phases", new ArrayList<>());
        state.put("completedPhases", List.of());
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

        // Start with the saved state data, then overlay plugin graphState
        var restored = new HashMap<>(snapshot.stateData());
        if (req.graphState() != null) {
            restored.putAll(req.graphState());
        }

        restored.put("sessionId", req.sessionId());
        restored.put("userId", userId);
        if (req.modelId() != null) {
            restored.put("modelId", req.modelId());
        }
        if (req.modelSource() != null) {
            restored.put("modelSource", req.modelSource().name());
        }
        if (req.input() != null && !req.input().isBlank()) {
            restored.put("input", req.input());
        }
        if (req.intent() != null) {
            restored.put("intent", req.intent().name());
        }

        List<ConversationRunRequest.Answer> answers = resolveResumeAnswers(req);
        if (!answers.isEmpty()) {
            restored.put("answers", answers);
            recordAnsweredNotes(restored, answers);
        }
        StuckStepRecovery.applyAnsweredStuckStep(restored);
        // Fresh user input on resume: drop stale failure budget from an earlier stuck step.
        if (!answers.isEmpty()) {
            Object retries = restored.get("phaseFailureRetries");
            if (retries instanceof Number n && n.intValue() >= 3) {
                StuckStepRecovery.clearStuckCounters(restored);
            }
        }

        if (req.contexts() != null
                && req.contexts().recent() != null
                && !req.contexts().recent().isEmpty()) {
            var historyMaps =
                    req.contexts().recent().stream()
                            .map(
                                    m -> {
                                        var map = new java.util.LinkedHashMap<String, String>();
                                        map.put("role", m.role());
                                        map.put("content", m.content());
                                        if (m.summary() != null) map.put("summary", m.summary());
                                        if (m.seq() != null) map.put("seq", String.valueOf(m.seq()));
                                        return map;
                                    })
                            .toList();
            restored.put("conversationHistory", historyMaps);
        }

        // Checkpoint nextNode wins over stale graphState fields
        restored.put("currentNode", snapshot.nextNode());
        restored.put("resumeNextNode", snapshot.nextNode());
        restored.remove("doneReason");
        restored.remove("awaiting");

        var state = new OverAllState(restored);
        STATE_KEYS.forEach(key -> state.registerKeyAndStrategy(key, new ReplaceStrategy()));

        log.info(
                "restoreFromCheckpoint: nextNode={}, stateKeys={}, answerCount={}, hasInput={}",
                snapshot.nextNode(),
                state.data().keySet(),
                answers.size(),
                req.input() != null && !req.input().isBlank());

        return state;
    }

    /**
     * Builds answers for resume: structured {@code answers[]} from the client, or a single
     * freeform answer synthesized from {@code input} when the user typed in the chat box.
     */
    static List<ConversationRunRequest.Answer> resolveResumeAnswers(ConversationRunRequest req) {
        if (req.answers() != null && !req.answers().isEmpty()) {
            return req.answers();
        }
        if (req.input() == null || req.input().isBlank()) {
            return List.of();
        }
        if (req.intent() == ConversationRunRequest.Intent.ANSWER
                || req.intent() == ConversationRunRequest.Intent.CONTINUE) {
            return List.of(new ConversationRunRequest.Answer("", null, req.input(), null));
        }
        return List.of();
    }

    @SuppressWarnings("unchecked")
    static void recordAnsweredNotes(
            Map<String, Object> restored, List<ConversationRunRequest.Answer> answers) {
        var ledger =
                new HashMap<>(
                        (Map<String, Object>)
                                restored.getOrDefault("taskLedger", Map.of()));
        var notes = new ArrayList<>((List<String>) ledger.getOrDefault("notes", List.of()));
        for (var answer : answers) {
            if (answer.questionId() != null && !answer.questionId().isBlank()) {
                String value =
                        answer.freeform() != null && !answer.freeform().isBlank()
                                ? answer.freeform()
                                : answer.optionId();
                notes.add("answered:" + answer.questionId() + "=" + value);
            } else if (answer.freeform() != null && !answer.freeform().isBlank()) {
                notes.add("answered:freeform=" + answer.freeform());
            } else if (answer.optionId() != null && !answer.optionId().isBlank()) {
                notes.add("answered:option=" + answer.optionId());
            }
        }
        ledger.put("notes", notes);
        restored.put("taskLedger", ledger);
    }
}
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
import io.codepilot.core.graph.PhaseOutcomeHelper;
import io.codepilot.core.graph.ProjectMetaHelper;
import io.codepilot.core.graph.StuckStepRecovery;
import io.codepilot.core.graph.ToolApproachTracker;
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
    private final io.codepilot.core.run.GraphEngineProperties graphProperties;

    public IntakeAction(IntakeIntentClassifier intakeIntentClassifier,
                        io.codepilot.core.run.GraphEngineProperties graphProperties) {
        this.intakeIntentClassifier = intakeIntentClassifier;
        this.graphProperties = graphProperties;
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
            // deep-research outputs
            "searchRound",
            "answers", "graphTemplate",
            // planning outputs
            "userPlan", "planningResult",
            // deep-research outputs
            "evaluateResult",
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
            "dispatchPath",
            // ── Four-layer memory keys ──
            "activeMemories", "instantMemories", "shortTermMemories",
            "projectMemories", "globalMemories", "memoryAnomalies",
            "memoryCandidates", "changeLineage", "memoryBudget", "memoryNeedsCompact",
            // ── Summarize outputs ──
            "summarizeResult",
            // ── Request-level keys (from ConversationRunRequest, must be registered) ──
            "projectRootHash", "projectRules",
            // ── Config-level keys (propagated from GraphEngineProperties for runtime access) ──
            "maxPhaseFailureAttempts", "maxGeneratePassesPerPhase", "stateArchiveThreshold",
            // ── Hierarchical planning keys ──
            "macroPhases", "macroPhaseCursor", "hierarchicalPlan",
            // ── Batch generation keys ──
            "accumulatedPatches",
            // ── State archiving keys ──
            "archivedPhaseCount",
            // ── Dynamic plan expand keys ──
            "expandResult",
            // ── PreCheck product dependency keys (LLM-declared phase metadata) ──
            "requiredProducts", "productPatterns", "productSearchPaths",
            // ── Context split keys ──
            "contextSplitResult", "contextSourceId", "contextShardCount", "loadShardMode",
            // ── Compacted context key (for session recovery from compressed context) ──
            "compactedSummary"
    );

    /** Session-scoped keys preserved across graph runs in the same conversation (CONTINUE / graphState). */
    private static final List<String> SESSION_PERSISTENT_KEYS =
            List.of(
                    "sessionExecutionFacts",
                    "sessionHasSourceReads",
                    "sessionHasAnalysisOutput",
                    "sessionHadSuccessfulCompile",
                    "sessionHadSuccessfulRun",
                    "summaryForNextTurn",
                    "sessionDigest");

    /** Per-run execution keys cleared on NEW; phase keys also cleared on CONTINUE. */
    private static final List<String> STALE_EXECUTION_KEYS =
            List.of(
                    "gatheredInfo",
                    "phaseHasAnalysisOutput",
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

        // ★ Carry over resumeNextNode so it survives the intake→contextSplit→memoryLoad path.
        // Without this, the key may be lost when OverAllState.updateState merges the
        // partial updates (intake's updates only contain ~9 keys, and the framework's
        // overAllState.updateState(partialState) only writes keys present in partialState).
        // If resumeNextNode is missing from overAllState after intake, routeAfterMemoryLoad
        // will always fall through to "planning", defeating the resume shortcut.
        state.<String>value("resumeNextNode").ifPresent(v -> {
            if (!v.isBlank()) updates.put("resumeNextNode", v);
        });

        // ── Inject runtime config from GraphEngineProperties into state ──
        // This allows static helpers (PhaseFailureRepairHelper, PhaseGoalHelper) to read
        // configurable thresholds without needing Spring injection.
        updates.put("maxPhaseFailureAttempts", graphProperties.getMaxPhaseFailureAttempts());
        updates.put("maxGeneratePassesPerPhase", graphProperties.getMaxGeneratePassesPerPhase());
        updates.put("stateArchiveThreshold", graphProperties.getStateArchiveThreshold());
        updates.put("memoryBudget", graphProperties.getMemoryBudget());

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
                                        Map.of("attempts", 1, "skipVerify", true)));
                updates.put("phases", phases);
                updates.put("phaseCursor", "p1");
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
        // DispatchPath is determined by task complexity, not tool type:
        // CONVERSATIONAL → intentDispatch (pure Q&A)
        // SIMPLE → intentDispatch (tool-assisted, no multi-step plan)
        // GRAPH → planning → generate → ... (full pipeline)
        @SuppressWarnings("unchecked")
        Map<String, Object> intakeIntent =
                (Map<String, Object>) state.value("intakeIntent").orElse(Map.of());
        String dispatchPathStr =
                String.valueOf(intakeIntent.getOrDefault("dispatchPath", ""));
        if ("CONVERSATIONAL".equals(dispatchPathStr) || "SIMPLE".equals(dispatchPathStr)) {
            log.info("IntakeAction route: {} → intentDispatch", dispatchPathStr);
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
        // Used by prompts to specialize behavior (e.g. deep-research loops).
        initial.put(
                "graphTemplate",
                req.policy() != null && req.policy().graphTemplate() != null
                        ? req.policy().graphTemplate()
                        : "default");
        initial.put("modelId", req.modelId());
        initial.put("modelSource", req.modelSource() != null ? req.modelSource().name() : null);
        initial.put("userId", userId);
        initial.put("projectMeta", req.projectMeta() != null ? req.projectMeta() : "");
        initial.put("currentNode", "intake");
        initial.put("phaseCursor", "");
        initial.put("phases", new ArrayList<>());
        initial.put("attempts", new HashMap<String, Integer>());
        initial.put("gathered", new ArrayList<>());
        initial.put("sseEvents", new java.util.concurrent.CopyOnWriteArrayList<Map<String, Object>>());
        initial.put("gatherResumeTo", "");
        initial.put("gatherLoopCount", 0);
        initial.put("searchRound", 0);
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
            // ── Compacted context recovery ──
            // When a previous session produced a compactedSummary (via CommitAction.compactActiveMemories),
            // the sessionDigest carries the __COMPACTED__ marker. On session recovery, we detect this
            // and restore context from the compacted summary instead of replaying the full conversation
            // history. This prevents loading potentially huge conversation history for super-complex tasks
            // that ran hundreds of phases.
            String compactedSummary = resolveCompactedSummary(req);
            if (compactedSummary != null && !compactedSummary.isBlank()) {
                // Use compacted summary as the sole conversation context — skip full history
                var compactedHistory = new java.util.ArrayList<Map<String, String>>();
                var systemMap = new java.util.LinkedHashMap<String, String>();
                systemMap.put("role", "system");
                systemMap.put("content", "[COMPACTED SESSION CONTEXT — restored from compressed summary]\n" + compactedSummary);
                compactedHistory.add(systemMap);
                initial.put("conversationHistory", compactedHistory);
                initial.put("compactedSummary", compactedSummary);
                log.info("IntakeAction: detected compacted session context ({} chars), " +
                                "restoring from compressed summary instead of full history ({} messages skipped)",
                        compactedSummary.length(), req.contexts().recent().size());
            } else {
                // Normal path: no compaction marker — load full conversation history
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
            }
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
        } else if (req.intent() == Intent.CONTINUE) {
            clearPhaseExecutionState(initial);
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

    /** Drop per-run execution state on NEW; session facts stay if plugin merged them via graphState. */
    static void clearStaleExecutionState(Map<String, Object> state) {
        clearPhaseExecutionState(state);
    }

    /** Clear phase/run state but keep session execution facts for multi-turn CONTINUE. */
    static void clearPhaseExecutionState(Map<String, Object> state) {
        for (String key : STALE_EXECUTION_KEYS) {
            state.remove(key);
        }
        state.put("gatheredInfo", Map.of());
        state.put("phaseCursor", "");
        state.put("phases", new ArrayList<>());
        state.put("completedPhases", List.of());
    }

    /** After the user answers askUser, allow generate to proceed instead of re-asking.
     *
     * <p>Preserves askUser context (the question text and the agent's proposals) in
     * {@code taskLedger.notes} so the LLM can understand the user's answer (e.g.
     * "按方案1推进吧" references "方案1" from the askUser question). Without this,
     * the LLM would see the user's answer but not know what options were proposed.
     */
    @SuppressWarnings("unchecked")
    static void clearAskUserResumeEscalation(Map<String, Object> restored) {
        // ★ Before removing askUserQuestion and textOutput, save their content to taskLedger.notes
        // so the LLM can understand the user's answer in context of the original question.
        String askUserContextNote = buildAskUserContextNote(restored);
        if (!askUserContextNote.isBlank()) {
            var ledger = new HashMap<>(
                    (Map<String, Object>) restored.getOrDefault("taskLedger", Map.of()));
            var notes = new ArrayList<>((List<String>) ledger.getOrDefault("notes", List.of()));
            notes.add(askUserContextNote);
            ledger.put("notes", notes);
            restored.put("taskLedger", ledger);
        }

        restored.put("overallGoalUnmet", false);
        restored.remove("askUserQuestion");
        restored.remove("textOutput");
        restored.remove("generateResult");
        ToolApproachTracker.clearInPhase(restored);
        PhaseOutcomeHelper.clearPhaseToolState(restored);
    }

    /**
     * Build a context note from the askUser question and textOutput so the LLM
     * can understand the user's answer in context.
     */
    @SuppressWarnings("unchecked")
    private static String buildAskUserContextNote(Map<String, Object> restored) {
        StringBuilder sb = new StringBuilder("askUserContext:");
        Object askUserQuestion = restored.get("askUserQuestion");
        if (askUserQuestion instanceof Map<?, ?> qMap) {
            // Structured question with options
            Object title = qMap.get("title");
            Object text = qMap.get("text");
            if (title != null) sb.append(" title=").append(title);
            if (text != null) sb.append(" text=").append(truncateForNote(String.valueOf(text), 500));
            Object questions = qMap.get("questions");
            if (questions instanceof List<?> qList) {
                for (Object q : qList) {
                    if (q instanceof Map<?, ?> qItem) {
                        Object qPrompt = qItem.get("prompt");
                        Object qOptions = qItem.get("options");
                        if (qPrompt != null) sb.append(" question=").append(truncateForNote(String.valueOf(qPrompt), 200));
                        if (qOptions instanceof List<?> opts) {
                            for (Object opt : opts) {
                                if (opt instanceof Map<?, ?> optMap) {
                                    Object optId = optMap.get("id");
                                    Object optLabel = optMap.get("label");
                                    if (optId != null && optLabel != null) {
                                        sb.append(" option[").append(optId).append("]=").append(truncateForNote(String.valueOf(optLabel), 100));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } else if (askUserQuestion != null) {
            sb.append(" question=").append(truncateForNote(String.valueOf(askUserQuestion), 500));
        }

        Object textOutput = restored.get("textOutput");
        if (textOutput != null) {
            String textStr = truncateForNote(String.valueOf(textOutput), 800);
            sb.append(" agentProposal=").append(textStr);
        }

        return sb.length() > "askUserContext:".length() ? sb.toString() : "";
    }

    private static String truncateForNote(String s, int maxLen) {
        if (s == null) return "";
        return s.length() <= maxLen ? s : s.substring(0, maxLen) + "...";
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
            // ★ FIX: When resuming from an askUser interrupt, do NOT override the saved
            // `input` with the user's reply text. The user's reply (e.g. "按方案1推进吧")
            // references context from the askUser question (e.g. option 1/2/3), and replacing
            // the original input causes the LLM to treat the reply as a brand-new task.
            //
            // Previously we only skipped override for structured optionId answers. Now we also
            // skip for freeform answers when the checkpoint has a preserved original input,
            // because:
            // 1. The freeform text references the askUser question's context (options, proposals)
            // 2. Replacing input loses the original task description
            // 3. The answers list already carries the user's reply semantics
            //
            // The freeform text is preserved in taskLedger.notes via recordAnsweredNotes()
            // and injected into the generate prompt via buildAskUserAnswersDirective().
            boolean hasAnswers = req.answers() != null && !req.answers().isEmpty();
            boolean isAnswerIntent = req.intent() == ConversationRunRequest.Intent.ANSWER;
            boolean checkpointHasInput = restored.containsKey("input")
                    && restored.get("input") instanceof String savedInput
                    && !savedInput.isBlank();
            if (hasAnswers || (isAnswerIntent && checkpointHasInput)) {
                // The user is answering an askUser question and the checkpoint has the
                // original input preserved — keep the original input from the checkpoint.
                // The user's reply semantics are carried by the `answers` list.
                log.info("restoreFromCheckpoint: preserving original input from checkpoint, "
                        + "user reply is carried by answers (hasAnswers={}, isAnswerIntent={}, checkpointHasInput={})",
                        hasAnswers, isAnswerIntent, checkpointHasInput);
            } else {
                restored.put("input", req.input());
            }
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
            clearAskUserResumeEscalation(restored);
            Object retries = restored.get("phaseFailureRetries");
            if (retries instanceof Number n && n.intValue() >= 3) {
                StuckStepRecovery.clearStuckCounters(restored);
            }
        }

        if (req.contexts() != null
                && req.contexts().recent() != null
                && !req.contexts().recent().isEmpty()) {
            // ── Compacted context recovery on checkpoint resume ──
            // Same logic as buildInitialState: if the session has compactedSummary,
            // restore from it instead of replaying full conversation history.
            String compactedSummary = resolveCompactedSummary(req);
            if (compactedSummary != null && !compactedSummary.isBlank()) {
                var compactedHistory = new java.util.ArrayList<Map<String, String>>();
                var systemMap = new java.util.LinkedHashMap<String, String>();
                systemMap.put("role", "system");
                systemMap.put("content", "[COMPACTED SESSION CONTEXT — restored from compressed summary]\n" + compactedSummary);
                compactedHistory.add(systemMap);
                restored.put("conversationHistory", compactedHistory);
                restored.put("compactedSummary", compactedSummary);
                log.info("restoreFromCheckpoint: detected compacted session context ({} chars), " +
                                "restoring from compressed summary instead of full history",
                        compactedSummary.length());
            } else {
                // Normal path: load full conversation history
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
        }

        // Checkpoint nextNode wins over stale graphState fields
        restored.put("currentNode", snapshot.nextNode());
        restored.put("resumeNextNode", snapshot.nextNode());
        // ★ Restore phaseCursor from askUser checkpoint if present.
        // AskUserAction explicitly saves the current phaseCursor as "askUserPhaseCursor"
        // to prevent stale phaseCursor values from causing the resumed execution to
        // re-run already-completed phases (e.g. resuming at p2 instead of p3).
        Object askUserPhaseCursor = restored.remove("askUserPhaseCursor");
        if (askUserPhaseCursor instanceof String pc && !pc.isBlank()) {
            restored.put("phaseCursor", pc);
        }
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
    public static List<ConversationRunRequest.Answer> resolveResumeAnswers(ConversationRunRequest req) {
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

    /**
     * Resolve compacted summary from the request's session digest.
     * If the previous session had its context compressed (via CommitAction.compactActiveMemories),
     * the sessionDigest will carry a {@code compactedSummary} field with the compressed context.
     * This allows session recovery to restore from the compacted context instead of
     * replaying the full conversation history — critical for super-complex tasks where
     * the full history could be hundreds of messages long.
     *
     * @return the compacted summary string, or null if no compaction occurred
     */
    private static String resolveCompactedSummary(ConversationRunRequest req) {
        if (req.sessionDigest() == null) return null;
        // sessionDigest is a Digest record — check for compactedSummary field
        String compacted = req.sessionDigest().compactedSummary();
        return (compacted != null && !compacted.isBlank()) ? compacted : null;
    }
}
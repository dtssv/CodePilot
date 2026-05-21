package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.dto.NeedsInput;
import io.codepilot.core.graph.AskUserPolicy;
import io.codepilot.core.graph.GraphCheckpointStore;
import io.codepilot.core.graph.StuckStepRecovery;
import io.codepilot.core.graph.GraphInterruptException;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.sse.SseEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import java.time.Duration;
import java.util.*;

/**
 * AskUser node (terminal): emits structured needs_input SSE event,
 * sets done reason to awaiting_user_input, and stores continuation context.
 *
 * Supports 4 question kinds as designed in 01-§6.2:
 * - single-choice: one option from a list
 * - multi-choice: multiple options from a list
 * - yes-no: boolean decision
 * - freeform: open-ended text input
 *
 * Also filters out questions that were already answered (from taskLedger.notes).
 */
@Component
public class AskUserAction implements NodeAction {
    private static final Logger log = LoggerFactory.getLogger(AskUserAction.class);

    private final GraphCheckpointStore checkpointStore;

    public AskUserAction(GraphCheckpointStore checkpointStore) {
        this.checkpointStore = checkpointStore;
    }
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "askUser");
        updates.put("doneReason", "awaiting_user_input");

        // 1. Extract or build questions from state
        // Support both "pendingQuestions" (list format) and "askUserQuestion" (single question from Generate/Repair)
        var rawQuestions = new ArrayList<Map<String, Object>>();
        @SuppressWarnings("unchecked")
        var pendingList = (List<Map<String, Object>>) state.value("pendingQuestions").orElse(List.of());
        for (Map<String, Object> q : pendingList) {
            Map<String, Object> normalized = AskUserPolicy.normalizeQuestionMap(q);
            if (normalized != null) {
                rawQuestions.add(normalized);
            }
        }
        Object askRaw = state.value("askUserQuestion").orElse(null);
        Map<String, Object> normalizedSingle = AskUserPolicy.normalizeQuestion(askRaw);
        if (normalizedSingle != null) {
            rawQuestions.add(normalizedSingle);
        }
        Object verifyReportRaw = state.value("verifyReport").orElse(null);
        Map<String, Object> verifyReport = (verifyReportRaw instanceof Map<?, ?>) ? (Map<String, Object>) verifyReportRaw : null;
        var repairAttempts = (int) state.value("repairAttempts").orElse(0);
        var taskLedger = (Map<String, Object>) state.value("taskLedger").orElse(Map.of());
        var answeredNotes = (List<String>) taskLedger.getOrDefault("notes", List.of());

        // 2. Build questions if not already provided
        List<NeedsInput.Question> questions = new ArrayList<>();
        if (!rawQuestions.isEmpty()) {
            // Convert raw questions to structured format
            for (var q : rawQuestions) {
                NeedsInput.Question question = buildQuestion(q, answeredNotes);
                if (question != null) {
                    questions.add(question);
                }
            }
        } else {
            // Auto-generate questions based on context
            questions.addAll(generateDefaultQuestions(state, verifyReport, repairAttempts));
        }

        // 3. Filter out already-answered questions
        questions.removeIf(q -> isAlreadyAnswered(q, answeredNotes));

        if (questions.isEmpty()) {
            // All questions already answered, continue without asking
            // Route to the originating node so execution continues
            updates.putAll(StuckStepRecovery.consumeStuckAnswerIfPresent(state));
            log.info("AskUser: no unanswered questions, routing to originating node");
            String priorNode = (String) state.value("currentNode").orElse("repair");
            String origin = switch (priorNode) {
                case "preCheck", "generate", "verify", "repair", "planning" -> priorNode;
                default -> "repair";
            };
            updates.put("doneReason", "subtask_done");
            // Set awaiting.nextNode so routeAfterAskUser can route correctly
            Map<String, Object> autoAwaiting = new HashMap<>();
            autoAwaiting.put("nextNode", origin);
            autoAwaiting.put("continuationToken", "auto-continue");
            updates.put("awaiting", autoAwaiting);
            // Put a dummy answer so routeAfterAskUser takes the answers branch
            updates.put("answers", List.of(Map.of("questionId", "auto", "optionId", "auto-continue")));
            return updates;
        }

        // 4. Build NeedsInput structure
        String title = (String) state.value("askUserTitle").orElse(AskUserPolicy.defaultNeedsInputTitle());
        NeedsInput needsInput = new NeedsInput(title, null, true, 1, true, questions, null);

        // 5. Build continuation context for resume
        String continuationToken = UUID.randomUUID().toString();
        // Determine the originating node: the node that was active before askUser.
        // state.value("currentNode") returns the value BEFORE this apply() updates it,
        // so it's the node that routed to askUser.
        String originatingNode = (String) state.value("askUserOrigin").orElse(null);
        if (originatingNode == null || originatingNode.isBlank()) {
            // Infer from currentNode (the node that was active before this askUser)
            String priorNode = (String) state.value("currentNode").orElse("repair");
            originatingNode = switch (priorNode) {
                case "preCheck", "generate", "verify", "repair", "planning" -> priorNode;
                default -> "repair";
            };
        }
        Map<String, Object> awaiting = new HashMap<>();
        awaiting.put("continuationToken", continuationToken);
        awaiting.put("nextNode", originatingNode);
        awaiting.put("questionsSnapshot", questions);
        updates.put("awaiting", awaiting);

        // 6. Persist full graph state snapshot to Redis for interrupt-resume
        // This is the critical fix: save state so resume can reload and continue
        // BLOCK until save completes — if we throw GraphInterruptException before
        // the checkpoint is persisted, the resume flow will fail to find it.
        try {
            Map<String, Object> stateData = new HashMap<>(state.data());
            // Merge updates into stateData so the snapshot includes the latest changes
            stateData.putAll(updates);
            Boolean saved = checkpointStore.save(continuationToken, stateData, originatingNode)
                    .block(Duration.ofSeconds(5));
            if (Boolean.TRUE.equals(saved)) {
                log.info("AskUser: checkpoint saved for token={}, nextNode={}", continuationToken, originatingNode);
            } else {
                log.error("AskUser: checkpoint save returned false for token={}", continuationToken);
            }
        } catch (Exception e) {
            log.error("AskUser: checkpoint save error (non-fatal, graph will still suspend)", e);
        }

        // 7. Emit needs_input SSE event
        GraphSseHelper.emitEvent(state, SseEvents.NEEDS_INPUT, Map.of(
            "title", title,
            "questions", questions,
            "continuationToken", continuationToken
        ));

        // 8. Emit done event
        GraphSseHelper.emitEvent(state, SseEvents.DONE, Map.of(
            "reason", "awaiting_user_input",
            "continuationToken", continuationToken,
            "awaiting", awaiting
        ));

        log.info("AskUser: emitted {} questions, continuationToken={}, nextNode={}",
                questions.size(), continuationToken, originatingNode);

        // 9. Throw GraphInterruptException to truly halt the synchronous graph execution.
        // The StateGraph framework has no native "suspend" — without this exception,
        // graph.invoke() would continue to the next node (finalize) even though
        // we've already emitted the DONE event.
        // GraphEngineService catches this exception and gracefully closes the SSE stream.
        throw new GraphInterruptException(continuationToken, "awaiting_user_input");
    }

    @SuppressWarnings("unchecked")
    private NeedsInput.Question buildQuestion(Map<String, Object> raw, List<String> answeredNotes) {
        try {
            String id = (String) raw.getOrDefault("id", UUID.randomUUID().toString());
            // Support both "text" (structured format) and "question" (fallback from plain-string askUser)
            String text = (String) raw.getOrDefault("text", (String) raw.getOrDefault("question", ""));
            String kind = (String) raw.getOrDefault("kind", "single-choice");

            List<NeedsInput.Option> options = new ArrayList<>();
            var rawOptions = (List<Map<String, Object>>) raw.getOrDefault("options", List.of());
            for (var opt : rawOptions) {
                options.add(new NeedsInput.Option(
                    (String) opt.getOrDefault("id", ""),
                    (String) opt.getOrDefault("label", ""),
                    (String) opt.getOrDefault("impact", ""),
                    (List<String>) opt.getOrDefault("pros", List.of()),
                    (List<String>) opt.getOrDefault("cons", List.of())
                ));
            }

            // Parse kind safely — fallback to SINGLE_CHOICE for unknown values
            NeedsInput.Question.Kind questionKind;
            try {
                questionKind = NeedsInput.Question.Kind.valueOf(kind.replace("-", "_").toUpperCase());
            } catch (IllegalArgumentException e) {
                log.warn("Unknown question kind '{}', falling back to SINGLE_CHOICE", kind);
                questionKind = NeedsInput.Question.Kind.SINGLE_CHOICE;
            }

            return new NeedsInput.Question(id, null, text, null,
                questionKind,
                true, (String) raw.getOrDefault("defaultOptionId", null),
                options, null);
        } catch (Exception e) {
            log.warn("Failed to build question from raw data: {}", e.getMessage());
            return null;
        }
    }

    private List<NeedsInput.Question> generateDefaultQuestions(OverAllState state,
            Map<String, Object> verifyReport, int repairAttempts) {
        List<NeedsInput.Question> questions = new ArrayList<>();

        if (repairAttempts >= 2) {
            var options =
                    List.of(
                            new NeedsInput.Option("retry", "重试", "", List.of(), List.of()),
                            new NeedsInput.Option("skip", "跳过此步骤", "", List.of(), List.of()),
                            new NeedsInput.Option("abort", "停止任务", "", List.of(), List.of()),
                            new NeedsInput.Option("manual", "我手动处理", "", List.of(), List.of()));
            questions.add(
                    new NeedsInput.Question(
                            "repair-decision",
                            null,
                            "修复已失败 " + repairAttempts + " 次。请选择下一步：",
                            null,
                            NeedsInput.Question.Kind.SINGLE_CHOICE,
                            true,
                            "manual",
                            options,
                            null));
        }

        if (verifyReport != null && !verifyReport.isEmpty()) {
            var errors = (List<?>) verifyReport.getOrDefault("compileErrors", List.of());
            if (!errors.isEmpty()) {
                questions.add(
                        new NeedsInput.Question(
                                "compile-errors",
                                null,
                                "检测到编译错误，是否尝试换一种方式？",
                                null,
                                NeedsInput.Question.Kind.YES_NO,
                                true,
                                null,
                                List.of(),
                                null));
            }
        }

        return questions;
    }

    private boolean isAlreadyAnswered(NeedsInput.Question q, List<String> answeredNotes) {
        return answeredNotes.stream().anyMatch(note ->
            note.contains("answered:" + q.id()) || note.contains(q.prompt()));
    }

    /**
     * Route after askUser: determines where to go after user answers.
     *
     * <p>If the user has provided answers (state has "answers" from the resume request),
     * route to the nextNode specified in the "awaiting" state.
     * If no answers are provided (first-time askUser, no resume), route to finalize
     * (the graph will be suspended by the DONE event with awaiting_user_input reason).
     *
     * <p>This replaces the old direct edge askUser→END. Now askUser is an interrupt
     * point: the graph suspends (via DONE SSE), and on resume the user's answers
     * are injected into state, allowing this router to direct to the correct next node.
     */
    @SuppressWarnings("unchecked")
    public String routeAfterAskUser(OverAllState state) {
        // Check if user has provided answers (resume scenario)
        var answers = (List<?>) state.value("answers").orElse(List.of());
        if (!answers.isEmpty()) {
            // Resume: route to the nextNode stored in awaiting state
            var awaiting = (Map<String, Object>) state.value("awaiting").orElse(null);
            if (awaiting != null) {
            String nextNode = (String) awaiting.getOrDefault("nextNode", "repair");
            // Validate that nextNode is in the conditional edge mapping
            String validated = switch (nextNode) {
                case "repair", "generate", "planning", "preCheck",
                     "verify", "gather", "commit", "finalize" -> nextNode;
                default -> {
                    log.warn("AskUser route: invalid nextNode={}, falling back to repair", nextNode);
                    yield "repair";
                }
            };
            log.info("AskUser route: user answered, routing to nextNode={} (validated={})", nextNode, validated);
            return validated;
            }
        }

        // First-time askUser with no answers: the graph will be suspended
        // (DONE event emitted with awaiting_user_input reason).
        // Route to finalize as a safe fallback — the graph won't actually
        // continue because the GraphInterruptException halts execution.
        log.info("AskUser route: no answers yet, graph will suspend (awaiting_user_input)");
        return "finalize";
    }
}
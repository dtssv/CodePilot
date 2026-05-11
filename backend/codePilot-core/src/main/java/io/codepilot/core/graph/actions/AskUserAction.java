package io.codepilot.core.graph.actions;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.action.NodeAction;
import io.codepilot.core.dto.NeedsInput;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.sse.SseEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
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

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> apply(OverAllState state) {
        var updates = new HashMap<String, Object>();
        updates.put("currentNode", "askUser");
        updates.put("doneReason", "awaiting_user_input");

        // 1. Extract or build questions from state
        var rawQuestions = (List<Map<String, Object>>) state.value("pendingQuestions").orElse(List.of());
        var verifyReport = (Map<String, Object>) state.value("verifyReport").orElse(null);
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
            log.info("AskUser: no unanswered questions, forcing continue");
            updates.put("doneReason", "subtask_done");
            return updates;
        }

        // 4. Build NeedsInput structure
        String title = (String) state.value("askUserTitle").orElse("Need your input to continue");
        NeedsInput needsInput = new NeedsInput(title, null, true, 1, true, questions, null);

        // 5. Build continuation context for resume
        String continuationToken = UUID.randomUUID().toString();
        String originatingNode = (String) state.value("askUserOrigin").orElse("repair");
        Map<String, Object> awaiting = new HashMap<>();
        awaiting.put("continuationToken", continuationToken);
        awaiting.put("nextNode", originatingNode);
        awaiting.put("questionsSnapshot", questions);
        updates.put("awaiting", awaiting);

        // 6. Emit needs_input SSE event
        GraphSseHelper.emitEvent(state, SseEvents.NEEDS_INPUT, Map.of(
            "title", title,
            "questions", questions,
            "continuationToken", continuationToken
        ));

        // 7. Emit done event
        GraphSseHelper.emitEvent(state, SseEvents.DONE, Map.of(
            "reason", "awaiting_user_input",
            "continuationToken", continuationToken
        ));

        log.info("AskUser: emitted {} questions, continuationToken={}", questions.size(), continuationToken);
        return updates;
    }

    @SuppressWarnings("unchecked")
    private NeedsInput.Question buildQuestion(Map<String, Object> raw, List<String> answeredNotes) {
        try {
            String id = (String) raw.getOrDefault("id", UUID.randomUUID().toString());
            String text = (String) raw.getOrDefault("text", "");
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

            return new NeedsInput.Question(id, null, text, null,
                NeedsInput.Question.Kind.valueOf(kind.replace("-", "_").toUpperCase()),
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

        // If repair has been attempted multiple times, ask user how to proceed
        if (repairAttempts >= 2) {
            var options = List.of(
                new NeedsInput.Option("retry", "Retry repair with more context", "May succeed with additional info", List.of("Fresh attempt"), List.of("Takes more time")),
                new NeedsInput.Option("skip", "Skip this phase and continue", "Task proceeds but this phase may be incomplete", List.of("Avoids blocking"), List.of("Incomplete result")),
                new NeedsInput.Option("abort", "Abort the task", "Stops execution entirely", List.of("Clean stop"), List.of("No partial results")),
                new NeedsInput.Option("manual", "I'll fix it manually", "You take over and fix the issue", List.of("Human expertise"), List.of("Requires manual effort"))
            );
            questions.add(new NeedsInput.Question(
                "repair-decision", null, "Repair has failed " + repairAttempts + " times. How would you like to proceed?",
                null, NeedsInput.Question.Kind.SINGLE_CHOICE, true, "manual", options, null));
        }

        // If verify report has errors, ask about them
        if (verifyReport != null && !verifyReport.isEmpty()) {
            var errors = (List<?>) verifyReport.getOrDefault("compileErrors", List.of());
            if (!errors.isEmpty()) {
                questions.add(new NeedsInput.Question(
                    "compile-errors", null, "Compilation errors detected. Should I attempt a different approach?",
                    null, NeedsInput.Question.Kind.YES_NO, true, null, List.of(), null));
            }
        }

        return questions;
    }

    private boolean isAlreadyAnswered(NeedsInput.Question q, List<String> answeredNotes) {
        return answeredNotes.stream().anyMatch(note ->
            note.contains("answered:" + q.id()) || note.contains(q.prompt()));
    }
}
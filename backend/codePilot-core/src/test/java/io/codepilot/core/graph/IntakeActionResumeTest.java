package io.codepilot.core.graph;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.conversation.ConversationService;
import io.codepilot.core.dto.ConversationMode;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.graph.actions.IntakeAction;
import io.codepilot.core.model.ModelSource;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class IntakeActionResumeTest {

  @Test
  void restoreFromCheckpoint_synthesizesFreeformAnswerFromInput() {
    var snapshot =
        new GraphCheckpointStore.CheckpointSnapshot(
            "token-1",
            "repair",
            Map.of("sessionId", "s1", "doneReason", "awaiting_user_input"),
            System.currentTimeMillis());

    var req =
        new ConversationRunRequest(
            "s1",
            ConversationMode.AGENT,
            "model",
            ModelSource.GROUP,
            "please use option B",
            ConversationRunRequest.Intent.ANSWER,
            "token-1",
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null);

    OverAllState state = IntakeAction.restoreFromCheckpoint(snapshot, req, "user-1");

    assertEquals("repair", state.value("resumeNextNode").orElse(""));
    assertEquals("please use option B", state.value("input").orElse(""));
    @SuppressWarnings("unchecked")
    List<ConversationRunRequest.Answer> answers =
        (List<ConversationRunRequest.Answer>) state.value("answers").orElse(List.of());
    assertEquals(1, answers.size());
    assertEquals("please use option B", answers.get(0).freeform());
    @SuppressWarnings("unchecked")
    Map<String, Object> ledger = (Map<String, Object>) state.value("taskLedger").orElse(Map.of());
    @SuppressWarnings("unchecked")
    List<String> notes = (List<String>) ledger.getOrDefault("notes", List.of());
    assertTrue(notes.stream().anyMatch(n -> n.contains("freeform")));
  }

  @Test
  void resolveContinuationToken_readsNestedAwaiting() {
    var req =
        new ConversationRunRequest(
            "s1",
            ConversationMode.AGENT,
            "model",
            ModelSource.GROUP,
            "hi",
            ConversationRunRequest.Intent.CONTINUE,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            Map.of("awaiting", Map.of("continuationToken", "nested-token")),
            null);

    assertEquals("nested-token", ConversationService.resolveContinuationToken(req));
    assertTrue(ConversationService.shouldResumeFromCheckpoint(req, "nested-token"));
  }

  @Test
  void resolveResumeAnswers_prefersStructuredAnswers() {
    var answers =
        List.of(new ConversationRunRequest.Answer("q1", "opt-a", null, null));
    var req =
        new ConversationRunRequest(
            "s1",
            ConversationMode.AGENT,
            "model",
            ModelSource.GROUP,
            "ignored",
            ConversationRunRequest.Intent.ANSWER,
            "token",
            answers,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null);

    assertEquals(answers, IntakeAction.resolveResumeAnswers(req));
    assertFalse(IntakeAction.resolveResumeAnswers(req).isEmpty());
  }

  @Test
  void restoreFromCheckpoint_clearsAskUserEscalationAfterAnswer() {
    var snapshot =
        new GraphCheckpointStore.CheckpointSnapshot(
            "token-2",
            "generate",
            new HashMap<>(
                Map.of(
                    "sessionId",
                    "s1",
                    "doneReason",
                    "awaiting_user_input",
                    "overallGoalUnmet",
                    true,
                    "approachEscalationDone",
                    true,
                    "toolApproachExhausted",
                    true,
                    "askUserQuestion",
                    Map.of("kind", "freeform", "text", "pick one"),
                    "generateResult",
                    "askUser")),
            System.currentTimeMillis());

    var req =
        new ConversationRunRequest(
            "s1",
            ConversationMode.AGENT,
            "model",
            ModelSource.GROUP,
            "use g++ to compile",
            ConversationRunRequest.Intent.ANSWER,
            "token-2",
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null);

    OverAllState state = IntakeAction.restoreFromCheckpoint(snapshot, req, "user-1");

    assertFalse(Boolean.TRUE.equals(state.value("overallGoalUnmet").orElse(false)));
    assertFalse(Boolean.TRUE.equals(state.value("approachEscalationDone").orElse(false)));
    assertFalse(Boolean.TRUE.equals(state.value("toolApproachExhausted").orElse(false)));
    assertTrue(state.value("askUserQuestion").isEmpty());
  }
}

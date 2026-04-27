package io.codepilot.core.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * Strict JSON envelope the model must emit each turn. All fields nullable; JSON omits nulls.
 *
 * <p>Semantic order: {@code digest → taskLedger/taskLedgerDelta → plan|planDelta → selfCheck →
 * toolCall|needsInput|final} (with {@code riskNotice} accompanying a risky {@code toolCall}).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ModelEnvelope(
    Digest digest,
    TaskLedger taskLedger,
    TaskLedgerDelta taskLedgerDelta,
    Plan plan,
    PlanDelta planDelta,
    String thought,
    SelfCheck selfCheck,
    ToolCall toolCall,
    NeedsInput needsInput,
    FinalAnswer finalAnswer,
    RiskNotice riskNotice) {

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record FinalAnswer(
      String answer,
      Boolean subtaskDone,
      List<Patch> patches,
      String summaryForNextTurn) {}
}
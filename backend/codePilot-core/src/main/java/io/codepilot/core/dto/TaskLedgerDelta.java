package io.codepilot.core.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/** Incremental ledger update: only status changes / notes / blockers, no full subtask resend. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record TaskLedgerDelta(
    String setCursor,
    List<StatusUpdate> statusUpdates,
    List<String> appendNotes,
    List<String> appendBlockers) {

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record StatusUpdate(String id, TaskLedger.Subtask.Status status) {}
}
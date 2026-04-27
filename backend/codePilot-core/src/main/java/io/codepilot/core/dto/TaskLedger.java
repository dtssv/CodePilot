package io.codepilot.core.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/** Authoritative task ledger maintained by the model and rendered in the Plan/Ledger panel. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record TaskLedger(
    String goal, List<Subtask> subtasks, String cursor, List<String> notes, List<String> blockers) {

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Subtask(String id, String title, Status status, String why) {

    public enum Status {
      @JsonProperty("pending")
      PENDING,
      @JsonProperty("in_progress")
      IN_PROGRESS,
      @JsonProperty("done")
      DONE,
      @JsonProperty("blocked")
      BLOCKED,
      @JsonProperty("cancelled")
      CANCELLED
    }
  }
}
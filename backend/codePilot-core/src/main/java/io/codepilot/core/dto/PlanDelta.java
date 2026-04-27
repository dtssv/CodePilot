package io.codepilot.core.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/** Incremental plan update emitted on subsequent turns to keep payloads small. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PlanDelta(List<Op> ops) {

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Op(
      Kind op, String stepId, Plan.Step step, Plan.Step.Status status, String reason) {

    public enum Kind {
      @JsonProperty("add")
      ADD,
      @JsonProperty("modify")
      MODIFY,
      @JsonProperty("skip")
      SKIP,
      @JsonProperty("markStatus")
      MARK_STATUS
    }
  }
}
package io.codepilot.core.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/** Mandatory self-check produced by the model after a prior tool call. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SelfCheck(
    String toolCallId,
    String stepId,
    Boolean ok,
    Boolean matchedExpectation,
    List<Check> checks,
    List<Evidence> evidence,
    List<SideEffect> sideEffects,
    Risk risk,
    Action nextAction,
    String reason,
    String summaryForNextTurn,
    HintsForContext hintsForContext) {

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Check(String name, Boolean passed, String detail) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Evidence(String kind, String path, String range, String snippet) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record SideEffect(String op, String path, Integer linesChanged) {}

  public enum Risk {
    @JsonProperty("low") LOW,
    @JsonProperty("medium") MEDIUM,
    @JsonProperty("high") HIGH
  }

  public enum Action {
    @JsonProperty("continue") CONTINUE,
    @JsonProperty("retry") RETRY,
    @JsonProperty("replan") REPLAN,
    @JsonProperty("finalize") FINALIZE,
    @JsonProperty("ask_user") ASK_USER
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record HintsForContext(
      List<Pin> pin, List<Pin> unpin, List<Pin> requestRead) {

    public record Pin(String path, String range, String reason) {}
  }
}
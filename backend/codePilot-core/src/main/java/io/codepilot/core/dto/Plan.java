package io.codepilot.core.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;
import java.util.Map;

/** Plan document emitted by the model on the first turn or on replan. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record Plan(
    String goal,
    List<String> assumptions,
    List<String> constraints,
    List<String> successDefinition,
    List<Step> steps,
    List<String> terminationCriteria,
    List<String> outOfScope) {

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Step(
      String id,
      String title,
      String intent,
      List<String> tools,
      Map<String, Object> inputs,
      String expectedOutcome,
      List<String> acceptance,
      Risk riskLevel,
      Boolean reversible,
      List<String> dependsOn,
      Status status) {

    public enum Status {
      @JsonProperty("pending")
      PENDING,
      @JsonProperty("running")
      RUNNING,
      @JsonProperty("success")
      SUCCESS,
      @JsonProperty("failed")
      FAILED,
      @JsonProperty("skipped")
      SKIPPED,
      @JsonProperty("cancelled")
      CANCELLED
    }

    public enum Risk {
      @JsonProperty("low")
      LOW,
      @JsonProperty("medium")
      MEDIUM,
      @JsonProperty("high")
      HIGH
    }
  }
}
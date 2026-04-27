package io.codepilot.core.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/** Structured clarification request from the model. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record NeedsInput(
    String title,
    String reason,
    Boolean blocking,
    Integer maxAnswers,
    Boolean freeformAllowed,
    List<Question> questions,
    List<String> notesForUser) {

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Question(
      String id,
      Integer index,
      String prompt,
      String why,
      Kind kind,
      Boolean required,
      String defaultOptionId,
      List<Option> options,
      String placeholder) {

    public enum Kind {
      @JsonProperty("single-choice") SINGLE_CHOICE,
      @JsonProperty("multi-choice") MULTI_CHOICE,
      @JsonProperty("yes-no") YES_NO,
      @JsonProperty("freeform") FREEFORM
    }
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Option(
      String id, String label, String impact, List<String> pros, List<String> cons) {}
}
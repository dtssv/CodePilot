package io.codepilot.core.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/** Compact session digest emitted when context pressure triggers compaction. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record Digest(
    Integer boundarySeq,
    String goal,
    List<String> decisions,
    List<String> rejected,
    List<String> openQuestions,
    List<KeyFile> keyFiles,
    List<CompletedStep> completedSteps,
    List<String> pendingHints) {

  public record KeyFile(String path, String why) {}

  public record CompletedStep(String id, String summary) {}
}
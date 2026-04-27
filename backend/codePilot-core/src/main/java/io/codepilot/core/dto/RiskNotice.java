package io.codepilot.core.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/** Pre-flight notice for high-risk tool calls. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record RiskNotice(
    String toolCallId,
    String kind,
    String headline,
    String preview,
    Boolean reversible,
    EstimatedImpact estimatedImpact,
    List<Mitigation> mitigations) {

  public record EstimatedImpact(Integer filesTouched, Integer linesChanged) {}

  public record Mitigation(String id, String label) {}
}
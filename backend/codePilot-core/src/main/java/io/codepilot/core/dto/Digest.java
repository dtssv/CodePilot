package io.codepilot.core.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/** Compact session digest — enriched with structured fields for four-layer memory.

 * <p>Used both as context-pressure compaction output and as the
 * high-density summary persisted across sessions via sessionDigest.
 *
 * <p>New fields (superseding simple string lists):
 * <ul>
 *   <li>{@code architectureDecisions} — key design choices with rationale</li>
 *   <li>{@code rejectedApproaches} — failed approaches (prevents re-trying)</li>
 *   <li>{@code changeLineage} — files modified with change context</li>
 * </ul>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record Digest(
    Integer boundarySeq,
    String goal,
    List<String> decisions,
    List<String> rejected,
    List<String> openQuestions,
    List<KeyFile> keyFiles,
    List<CompletedStep> completedSteps,
    List<String> pendingHints,
    // ── Enriched structured fields (four-layer memory) ──
    /** Key architecture decisions with rationale: "chose X because Y". */
    List<String> architectureDecisions,
    /** Failed approaches to avoid re-trying: "approach X failed because Y". */
    List<String> rejectedApproaches,
    /** Files modified with change context: path + why it was changed. */
    List<ChangedFile> changeLineage,
    /** Memory anomalies detected during the session. */
    List<String> detectedAnomalies) {

  public record KeyFile(String path, String why) {}

  public record CompletedStep(String id, String summary) {}

  /** A file change with lineage context. */
  public record ChangedFile(String path, String reason, String phaseId) {}
}
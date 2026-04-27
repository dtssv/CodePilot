package io.codepilot.core.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/** Patch JSON used by Action endpoints and final answers; mirrors docs/04-Prompt模板.md §11. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record Patch(
    String summary,
    List<String> rationale,
    List<Edit> patches,
    DiffSummary diffSummary,
    Rollback rollback,
    List<String> followUps) {

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Edit(
      String path,
      Op op,
      String from,
      Range range,
      String search,
      String replace,
      String newContent,
      Boolean regex,
      Boolean ignoreCase,
      Integer expectMatches,
      String encoding,
      Eol eol,
      Boolean preserveBom) {

    public enum Op {
      @JsonProperty("create")
      CREATE,
      @JsonProperty("write")
      WRITE,
      @JsonProperty("replace")
      REPLACE,
      @JsonProperty("delete")
      DELETE,
      @JsonProperty("move")
      MOVE
    }

    public enum Eol {
      @JsonProperty("lf")
      LF,
      @JsonProperty("crlf")
      CRLF,
      @JsonProperty("auto")
      AUTO
    }

    public record Range(Integer startLine, Integer endLine) {}
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record DiffSummary(
      Integer filesTouched,
      Integer linesAdded,
      Integer linesRemoved,
      Boolean publicApiChanged,
      List<String> depsAdded,
      List<String> depsRemoved) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Rollback(String strategy, String instruction) {}
}
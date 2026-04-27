package io.codepilot.common.rag;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * Response for POST /v1/rag/search.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record RagSearchResult(List<Hit> hits) {

  public record Hit(
      String path,
      double score,
      String snippet,
      Range range) {}

  public record Range(int startLine, int endLine) {}
}
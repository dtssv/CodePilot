package io.codepilot.common.rag;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.NotBlank;
import java.util.List;

/**
 * Request body for POST /v1/rag/index — upload code snippets for indexing.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record RagIndexRequest(
    @NotBlank String sessionId,
    List<IndexItem> items) {

  public record IndexItem(
      @NotBlank String path,
      String language,
      @NotBlank String content,
      String hash) {}
}
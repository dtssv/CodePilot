package io.codepilot.common.rag;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.NotBlank;

/**
 * Request body for POST /v1/rag/search.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record RagSearchRequest(
    @NotBlank String sessionId,
    @NotBlank String query,
    int topK) {

  public RagSearchRequest {
    if (topK <= 0) topK = 8;
  }
}
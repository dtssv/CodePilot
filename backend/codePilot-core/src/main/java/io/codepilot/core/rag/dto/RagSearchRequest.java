package io.codepilot.core.rag.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.UUID;

/**
 * Request body for {@code POST /v1/rag/search}.
 *
 * @param sessionId scope to search within
 * @param query natural-language query text
 * @param topK maximum results to return (1-50, default 8)
 */
public record RagSearchRequest(
    @NotNull UUID sessionId,
    @NotBlank String query,
    @Min(1) @Max(50) Integer topK) {

  public int effectiveTopK() {
    return topK == null ? 8 : topK;
  }
}
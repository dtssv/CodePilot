package io.codepilot.core.rag.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import java.util.List;
import java.util.UUID;

/**
 * Request body for {@code POST /v1/rag/index}.
 *
 * @param sessionId session scope for the index
 * @param userId owner of the chunks
 * @param chunks the code chunks to embed and store
 */
public record RagIndexRequest(
    @NotNull UUID sessionId,
    @NotNull UUID userId,
    @NotEmpty @Valid List<ChunkPayload> chunks) {

  /**
   * A single chunk submitted for indexing.
   *
   * @param path project-relative file path
   * @param lang detected language (nullable; server auto-detects if missing)
   * @param startLine starting line (1-based, nullable)
   * @param endLine ending line (1-based, nullable)
   * @param content the raw textual content of the chunk (max 32 KB)
   */
  public record ChunkPayload(
      @NotBlank String path, String lang, Integer startLine, Integer endLine, String content) {}
}
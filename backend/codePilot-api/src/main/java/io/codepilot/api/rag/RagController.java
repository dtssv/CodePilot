package io.codepilot.api.rag;

import io.codepilot.common.api.ApiResponse;
import io.codepilot.core.rag.RagService;
import io.codepilot.core.rag.dto.RagIndexRequest;
import io.codepilot.core.rag.dto.RagSearchRequest;
import io.codepilot.core.rag.dto.RagSearchResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * REST endpoints for the RAG (Retrieval-Augmented Generation) subsystem. All data is session-scoped
 * and automatically expires after 24 hours.
 */
@Tag(name = "rag", description = "RAG embedding index & search")
@RestController
@RequestMapping(value = "/v1/rag", produces = MediaType.APPLICATION_JSON_VALUE)
public class RagController {

  private final RagService ragService;

  public RagController(RagService ragService) {
    this.ragService = ragService;
  }

  /**
   * Index code chunks: compute embeddings and store in pgvector. Supports batch upload up to 200
   * chunks per request.
   */
  @Operation(summary = "Index code chunks into session-scoped RAG store")
  @PostMapping(value = "/index", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, Integer>> index(@RequestBody @Valid RagIndexRequest request) {
    int indexed = ragService.index(request);
    return ApiResponse.ok(Map.of("indexed", indexed));
  }

  /**
   * Semantic search over indexed chunks for a session. Returns top-k results ordered by cosine
   * similarity.
   */
  @Operation(summary = "Search session RAG index by semantic similarity")
  @PostMapping(value = "/search", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<RagSearchResponse> search(@RequestBody @Valid RagSearchRequest request) {
    RagSearchResponse response = ragService.search(request);
    return ApiResponse.ok(response);
  }

  /**
   * Delete all indexed chunks for a session (explicit cleanup; also happens automatically after 24
   * hours).
   */
  @Operation(summary = "Delete all RAG chunks for a session")
  @DeleteMapping("/{sessionId}")
  public ApiResponse<Map<String, Integer>> deleteBySession(@PathVariable UUID sessionId) {
    int deleted = ragService.deleteBySession(sessionId);
    return ApiResponse.ok(Map.of("deleted", deleted));
  }
}

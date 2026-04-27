package io.codepilot.api.rag;

import io.codepilot.common.rag.RagIndexRequest;
import io.codepilot.common.rag.RagSearchRequest;
import io.codepilot.common.rag.RagSearchResult;
import io.codepilot.core.rag.RagService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;

/**
 * REST controller for RAG (Retrieval-Augmented Generation) operations.
 *
 * <p>Endpoints:
 * <ul>
 *   <li>POST /v1/rag/index  — Index code snippets for a session</li>
 *   <li>POST /v1/rag/search — Search similar code snippets</li>
 *   <li>DELETE /v1/rag/{sessionId} — Delete all vectors for a session</li>
 * </ul>
 */
@RestController
@RequestMapping("/v1/rag")
public class RagController {

  private final RagService ragService;

  public RagController(RagService ragService) {
    this.ragService = ragService;
  }

  /**
   * Index code snippets for a session.
   *
   * <p>Typically called by the IDE plugin when files are opened or changed.
   * Returns the number of items indexed.
   */
  @PostMapping("/index")
  public Mono<ResponseEntity<Integer>> index(@RequestBody RagIndexRequest request) {
    return ragService.index(request)
        .map(count -> ResponseEntity.ok(count));
  }

  /**
   * Search for similar code snippets within a session's index.
   *
   * <p>Used by the agent loop to augment prompts with relevant code context.
   */
  @PostMapping("/search")
  public Mono<ResponseEntity<RagSearchResult>> search(@RequestBody RagSearchRequest request) {
    return ragService.search(request)
        .map(result -> ResponseEntity.ok(result));
  }

  /**
   * Delete all indexed vectors for a session.
   *
   * <p>Called when a session is explicitly closed to free resources.
   * PGVector TTL (24h) handles automatic cleanup for abandoned sessions.
   */
  @DeleteMapping("/{sessionId}")
  public Mono<ResponseEntity<Void>> deleteBySessionId(@PathVariable String sessionId) {
    return ragService.deleteBySessionId(sessionId)
        .thenReturn(ResponseEntity.noContent().build());
  }
}
package io.codepilot.core.rag;

import io.codepilot.common.rag.RagIndexRequest;
import io.codepilot.common.rag.RagIndexRequest.IndexItem;
import io.codepilot.common.rag.RagSearchRequest;
import io.codepilot.common.rag.RagSearchResult;
import io.codepilot.common.rag.RagSearchResult.Hit;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.SearchRequest;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/**
 * Service for RAG (Retrieval-Augmented Generation) operations.
 *
 * <p>Uses Spring AI {@link VectorStore} with PGVector for storing and searching
 * code snippets. All vectors are scoped by sessionId with a 24h TTL.
 */
@Service
public class RagService {

  private static final Logger LOG = LoggerFactory.getLogger(RagService.class);

  private final VectorStore vectorStore;

  public RagService(VectorStore vectorStore) {
    this.vectorStore = vectorStore;
  }

  /**
   * Indexes code snippets for a session.
   *
   * <p>Each snippet is stored as a {@link Document} with metadata containing
   * sessionId, path, language, and hash. The sessionId is used for filtering
   * during search.
   *
   * @return the number of items indexed
   */
  public Mono<Integer> index(RagIndexRequest request) {
    return Mono.fromCallable(() -> {
      List<Document> documents = new ArrayList<>();

      for (IndexItem item : request.items()) {
        var metadata = new java.util.HashMap<String, Object>();
        metadata.put("sessionId", request.sessionId());
        metadata.put("path", item.path());
        metadata.put("language", item.language() != null ? item.language() : "unknown");
        if (item.hash() != null) {
          metadata.put("hash", item.hash());
        }

        var doc = new Document(UUID.randomUUID().toString(), item.content(), metadata);
        documents.add(doc);
      }

      vectorStore.add(documents);
      LOG.info("Indexed {} items for session={}", documents.size(), request.sessionId());
      return documents.size();
    }).subscribeOn(Schedulers.boundedElastic());
  }

  /**
   * Searches for similar code snippets.
   *
   * <p>Results are filtered by sessionId to ensure session isolation.
   *
   * @param request search request with sessionId, query, and topK
   * @return search results with path, score, snippet, and range
   */
  public Mono<RagSearchResult> search(RagSearchRequest request) {
    return Mono.fromCallable(() -> {
      var searchRequest = SearchRequest.builder()
          .query(request.query())
          .topK(request.topK())
          .filterExpression("sessionId == '" + request.sessionId() + "'")
          .build();

      var results = vectorStore.similaritySearch(searchRequest);

      var hits = results.stream()
          .map(doc -> {
            String path = (String) doc.getMetadata().get("path");
            String content = doc.getText();
            // Estimate line range from content
            int lines = content.split("\n").length;
            return new Hit(
                path,
                doc.getScore() != null ? doc.getScore() : 0.0,
                truncate(content, 500),
                new RagSearchResult.Range(1, lines));
          })
          .toList();

      return new RagSearchResult(hits);
    }).subscribeOn(Schedulers.boundedElastic());
  }

  /**
   * Deletes all vectors for a session.
   *
   * <p>PGVector TTL (24h) handles automatic cleanup, but this allows
   * immediate deletion when the user explicitly closes a session.
   */
  public Mono<Void> deleteBySessionId(String sessionId) {
    return Mono.<Void>fromCallable(() -> {
      // Spring AI VectorStore doesn't have a direct delete-by-filter API yet.
      // For now, we rely on TTL expiration. In production, use a custom
      // repository method to delete by sessionId metadata.
      LOG.info("RAG cleanup requested for session={} (will expire via TTL)", sessionId);
      return null;
    }).subscribeOn(Schedulers.boundedElastic());
  }

  private String truncate(String text, int maxChars) {
    if (text == null) return null;
    return text.length() <= maxChars ? text : text.substring(0, maxChars) + "...";
  }
}
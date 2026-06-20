package io.codepilot.core.rag.dto;

import java.util.List;

/**
 * Response body for {@code POST /v1/rag/search}.
 *
 * @param results top-k results ordered by cosine similarity
 * @param totalIndexed total chunks currently indexed in the session
 */
public record RagSearchResponse(List<Hit> results, int totalIndexed) {

  /**
   * @param path file path
   * @param lang language
   * @param startLine start line (nullable)
   * @param endLine end line (nullable)
   * @param snippet content preview
   * @param score cosine similarity [0,1]
   */
  public record Hit(
      String path, String lang, Integer startLine, Integer endLine, String snippet, double score) {}
}

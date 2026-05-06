package io.codepilot.core.rag;

/**
 * A single search result row from cosine similarity search.
 *
 * @param path project-relative file path
 * @param lang detected language
 * @param startLine start line (nullable)
 * @param endLine end line (nullable)
 * @param snippet the stored snippet preview (max 4 KB)
 * @param score cosine similarity score [0,1]
 */
public record RagSearchHit(
    String path, String lang, Integer startLine, Integer endLine, String snippet, double score) {}
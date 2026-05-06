package io.codepilot.core.rag;

import java.util.UUID;

/**
 * Immutable value representing a single code chunk to be stored in pgvector.
 *
 * @param sessionId the session that owns this chunk
 * @param userId the owner user
 * @param path file path within the project
 * @param lang detected language (e.g. "java", "ts")
 * @param startLine starting line number (1-based, nullable)
 * @param endLine ending line number (1-based, nullable)
 * @param contentHash sha256 hex of the raw chunk content
 * @param snippet redacted preview of the chunk (max 4 KB)
 * @param embedding 1536-dim float array from the embedding model
 */
public record RagChunk(
    UUID sessionId,
    UUID userId,
    String path,
    String lang,
    Integer startLine,
    Integer endLine,
    String contentHash,
    String snippet,
    float[] embedding) {}
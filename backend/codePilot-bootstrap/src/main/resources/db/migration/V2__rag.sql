-- ============================================================================
--  RAG vector store (session-scoped, short TTL; no user code persisted).
--  MySQL 8.0+ — embedding stored as BLOB (binary float array).
--  Cosine similarity computed at application layer (Spring AI / Java).
-- ============================================================================

CREATE TABLE IF NOT EXISTS rag_chunks (
    id           BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    session_id   CHAR(36)     NOT NULL,
    user_id      CHAR(36)     NOT NULL,
    path         VARCHAR(1024) NOT NULL,
    lang         VARCHAR(32),
    start_line   INT,
    end_line     INT,
    content_hash VARCHAR(64)  NOT NULL COMMENT 'sha256 of the chunk content',
    snippet      TEXT         NOT NULL COMMENT 'redacted preview (<=4 KB)',
    embedding    BLOB         NOT NULL COMMENT '1536-dim float32 vector (6144 bytes)',
    created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    expires_at   DATETIME(3)  NOT NULL,
    INDEX idx_rag_session (session_id),
    INDEX idx_rag_expires (expires_at),
    INDEX idx_rag_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Note: MySQL does not have native vector similarity search.
-- Cosine similarity is computed in the application layer:
--   1. Fetch all embeddings for the session (filtered by session_id + expires_at > NOW())
--   2. Compute cosine similarity in Java using the float[] arrays
--   3. Return top-K results
-- For high-volume production use, consider integrating with an external vector DB
-- (Milvus, Weaviate, Elasticsearch kNN) alongside MySQL for metadata.
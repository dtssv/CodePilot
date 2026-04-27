-- ============================================================================
--  RAG vector store (session-scoped, short TTL; no user code persisted).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "vector";

CREATE TABLE IF NOT EXISTS rag_chunks (
    id           BIGSERIAL    PRIMARY KEY,
    session_id   UUID         NOT NULL,
    user_id      UUID         NOT NULL,
    path         TEXT         NOT NULL,
    lang         TEXT,
    start_line   INTEGER,
    end_line     INTEGER,
    content_hash TEXT         NOT NULL, -- sha256 of the chunk content
    snippet      TEXT         NOT NULL, -- redacted preview (<= 4 KB)
    embedding    VECTOR(1536) NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_rag_session  ON rag_chunks (session_id);
CREATE INDEX IF NOT EXISTS idx_rag_expires  ON rag_chunks (expires_at);
CREATE INDEX IF NOT EXISTS idx_rag_embedding ON rag_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 200);

COMMENT ON TABLE rag_chunks IS
  'Embeddings of opportunistic code chunks; purged after 24h. Never used for training and never shared across sessions.';
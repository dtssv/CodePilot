-- ============================================================================
--  Share snapshots & cloud background agent registry (PostgreSQL).
-- ============================================================================

CREATE TABLE IF NOT EXISTS background_agent_tasks (
    id              VARCHAR(36)    PRIMARY KEY,
    status          VARCHAR(32)    NOT NULL DEFAULT 'queued',
    title           VARCHAR(256)   NOT NULL DEFAULT 'Background task',
    prompt          TEXT           NOT NULL,
    worktree_path   VARCHAR(1024),
    local_task_id   VARCHAR(128),
    branch_name     VARCHAR(256),
    task_json       JSONB          NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bg_status ON background_agent_tasks (status);
CREATE INDEX IF NOT EXISTS idx_bg_updated ON background_agent_tasks (updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_shares (
    id              VARCHAR(36)    PRIMARY KEY,
    title           VARCHAR(512)   NOT NULL DEFAULT 'CodePilot Share',
    format          VARCHAR(32)    NOT NULL DEFAULT 'markdown',
    content         TEXT           NOT NULL,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ    NOT NULL,
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_share_expires ON conversation_shares (expires_at);
CREATE INDEX IF NOT EXISTS idx_share_revoked ON conversation_shares (revoked_at);

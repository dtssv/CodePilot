-- ============================================================================
--  Share snapshots & cloud background agent registry (replaces file stores).
--  Target: MySQL 8.0+
-- ============================================================================

CREATE TABLE IF NOT EXISTS background_agent_tasks (
    id              CHAR(36)       NOT NULL PRIMARY KEY,
    status          VARCHAR(32)    NOT NULL DEFAULT 'queued',
    title           VARCHAR(256)   NOT NULL DEFAULT 'Background task',
    prompt          MEDIUMTEXT     NOT NULL,
    worktree_path   VARCHAR(1024)  NULL,
    local_task_id   VARCHAR(128)   NULL,
    branch_name     VARCHAR(256)   NULL,
    task_json       JSON           NOT NULL COMMENT 'Full task payload for plugin sync',
    created_at      DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at      DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    ended_at        DATETIME(3)    NULL,
    INDEX idx_bg_status (status),
    INDEX idx_bg_updated (updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversation_shares (
    id              CHAR(36)       NOT NULL PRIMARY KEY,
    title           VARCHAR(512)   NOT NULL DEFAULT 'CodePilot Share',
    format          VARCHAR(32)    NOT NULL DEFAULT 'markdown',
    content         MEDIUMTEXT     NOT NULL,
    created_at      DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    expires_at      DATETIME(3)    NOT NULL,
    revoked_at      DATETIME(3)    NULL,
    INDEX idx_share_expires (expires_at),
    INDEX idx_share_revoked (revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

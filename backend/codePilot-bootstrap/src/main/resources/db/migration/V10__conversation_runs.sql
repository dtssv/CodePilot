-- ============================================================================
-- Durable conversation runs (P2b): survive rolling deploy via DB + reclaim.
-- Target: MySQL 8.0+
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversation_runs (
    id                  CHAR(36)       NOT NULL PRIMARY KEY,
    session_id          VARCHAR(128)   NOT NULL,
    user_id             VARCHAR(128)   NULL,
    status              VARCHAR(32)    NOT NULL DEFAULT 'queued',
    request_json        JSON           NOT NULL,
    continuation_token  VARCHAR(256)   NULL,
    worker_id           VARCHAR(128)   NULL,
    lease_until         DATETIME(3)    NULL,
    last_seq            INT            NOT NULL DEFAULT 0,
    error_message       VARCHAR(1024)  NULL,
    created_at          DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at          DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    ended_at            DATETIME(3)    NULL,
    INDEX idx_cr_status_lease (status, lease_until),
    INDEX idx_cr_session (session_id),
    INDEX idx_cr_updated (updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversation_run_events (
    run_id              CHAR(36)       NOT NULL,
    seq                 INT            NOT NULL,
    event_name          VARCHAR(64)    NOT NULL,
    payload_json        MEDIUMTEXT     NOT NULL,
    created_at          DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (run_id, seq),
    INDEX idx_cre_run (run_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

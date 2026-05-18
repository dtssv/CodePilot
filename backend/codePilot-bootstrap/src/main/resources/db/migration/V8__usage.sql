-- ============================================================================
--  Usage records & daily quota ceilings (replaces file-backed store).
--  Target: MySQL 8.0+
-- ============================================================================

CREATE TABLE IF NOT EXISTS usage_records (
    id              BIGINT         NOT NULL AUTO_INCREMENT PRIMARY KEY,
    recorded_at     DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ts_epoch_ms     BIGINT         NOT NULL COMMENT 'Client event time (epoch millis)',
    user_id         VARCHAR(64)    NOT NULL DEFAULT 'default',
    session_id      VARCHAR(128)   NULL,
    turn_id         VARCHAR(128)   NULL,
    model_id        VARCHAR(128)   NOT NULL DEFAULT 'default',
    tier            VARCHAR(32)    NULL,
    input_tokens    INT            NOT NULL DEFAULT 0,
    output_tokens   INT            NOT NULL DEFAULT 0,
    cost_usd        DECIMAL(14, 6) NOT NULL DEFAULT 0,
    source          VARCHAR(32)    NULL COMMENT 'plugin / gateway',
    extra_json      JSON           NOT NULL,
    INDEX idx_usage_user_ts (user_id, ts_epoch_ms DESC),
    INDEX idx_usage_session_ts (session_id, ts_epoch_ms DESC),
    INDEX idx_usage_model_ts (model_id, ts_epoch_ms DESC),
    INDEX idx_usage_recorded (recorded_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS usage_daily_quotas (
    user_id           VARCHAR(64)    NOT NULL PRIMARY KEY,
    daily_limit_usd   DECIMAL(14, 4) NOT NULL DEFAULT 0,
    updated_at        DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

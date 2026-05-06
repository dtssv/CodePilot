-- ============================================================================
--  Audit log (metadata only; never stores user code / chat content).
--  Target: MySQL 8.0+
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_events (
    id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ts          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    trace_id    VARCHAR(64),
    tenant_id   CHAR(36),
    user_id     CHAR(36),
    device_id   VARCHAR(256),
    kind        VARCHAR(64)  NOT NULL COMMENT 'e.g. tool_executed / patch_applied / command_blocked',
    severity    ENUM('info','warn','error') NOT NULL DEFAULT 'info',
    code        INT,
    message     VARCHAR(1024),
    args_hash   VARCHAR(128),
    duration_ms INT,
    extra_json  JSON         NOT NULL,
    INDEX idx_audit_user_ts (user_id, ts DESC),
    INDEX idx_audit_kind_ts (kind, ts DESC),
    INDEX idx_audit_trace (trace_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- == Skill / system-prompt leak events ====================================

CREATE TABLE IF NOT EXISTS system_leak_events (
    id             BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ts             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    trace_id       VARCHAR(64),
    user_id        CHAR(36),
    model_name     VARCHAR(128),
    phase          ENUM('pre','post') NOT NULL,
    matched_rule   VARCHAR(256) NOT NULL,
    matched_hash   VARCHAR(128),
    sample_excerpt VARCHAR(200) COMMENT '200-char redacted excerpt for forensics',
    INDEX idx_sysleak_ts (ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
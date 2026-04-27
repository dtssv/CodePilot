-- ============================================================================
--  Audit log (metadata only; never stores user code / chat content).
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_events (
    id         BIGSERIAL    PRIMARY KEY,
    ts         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    trace_id   TEXT,
    tenant_id  UUID,
    user_id    UUID,
    device_id  TEXT,
    kind       TEXT         NOT NULL,   -- e.g. tool_executed / patch_applied / command_blocked / update_*
    severity   TEXT         NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','error')),
    code       INTEGER,
    message    TEXT,
    args_hash  TEXT,
    duration_ms INTEGER,
    extra_json JSONB        NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_user_ts ON audit_events (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_kind_ts ON audit_events (kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_trace   ON audit_events (trace_id);

COMMENT ON TABLE audit_events IS
  'Per-request audit metadata; the plaintext message/args are never stored, only hashes.';

-- == Skill / system-prompt leak events ====================================

CREATE TABLE IF NOT EXISTS system_leak_events (
    id             BIGSERIAL   PRIMARY KEY,
    ts             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    trace_id       TEXT,
    user_id        UUID,
    model_name     TEXT,
    phase          TEXT        NOT NULL CHECK (phase IN ('pre','post')),
    matched_rule   TEXT        NOT NULL,
    matched_hash   TEXT,
    sample_excerpt TEXT        -- 200-char redacted excerpt for forensics
);

CREATE INDEX IF NOT EXISTS idx_sysleak_ts ON system_leak_events (ts DESC);
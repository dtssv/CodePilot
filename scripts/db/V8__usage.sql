-- ============================================================================
--  Usage records & daily quota ceilings (PostgreSQL / pgvector dev stack).
-- ============================================================================

CREATE TABLE IF NOT EXISTS usage_records (
    id              BIGSERIAL PRIMARY KEY,
    recorded_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    ts_epoch_ms     BIGINT         NOT NULL,
    user_id         VARCHAR(64)    NOT NULL DEFAULT 'default',
    session_id      VARCHAR(128),
    turn_id         VARCHAR(128),
    model_id        VARCHAR(128)   NOT NULL DEFAULT 'default',
    tier            VARCHAR(32),
    input_tokens    INT            NOT NULL DEFAULT 0,
    output_tokens   INT            NOT NULL DEFAULT 0,
    cost_usd        NUMERIC(14, 6) NOT NULL DEFAULT 0,
    source          VARCHAR(32),
    extra_json      JSONB          NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_usage_user_ts ON usage_records (user_id, ts_epoch_ms DESC);
CREATE INDEX IF NOT EXISTS idx_usage_session_ts ON usage_records (session_id, ts_epoch_ms DESC);
CREATE INDEX IF NOT EXISTS idx_usage_model_ts ON usage_records (model_id, ts_epoch_ms DESC);
CREATE INDEX IF NOT EXISTS idx_usage_recorded ON usage_records (recorded_at DESC);

CREATE TABLE IF NOT EXISTS usage_daily_quotas (
    user_id           VARCHAR(64)    PRIMARY KEY,
    daily_limit_usd   NUMERIC(14, 4) NOT NULL DEFAULT 0,
    updated_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- Custom model configurations created by users.
-- API keys are stored AES-256 encrypted; the encryption key comes from KMS/env.
CREATE TABLE IF NOT EXISTS custom_model (
    id              BIGSERIAL      PRIMARY KEY,
    user_id         TEXT           NOT NULL,
    name            TEXT           NOT NULL,
    protocol        TEXT           NOT NULL DEFAULT 'openai',
    base_url        TEXT           NOT NULL,
    api_key_enc     TEXT           NOT NULL,          -- AES-256-GCM encrypted
    model           TEXT           NOT NULL,
    headers         JSONB          DEFAULT '{}',
    timeout_ms      INT            DEFAULT 60000,
    caps            JSONB          DEFAULT '[]',      -- capability flags
    max_tokens      INT            DEFAULT 128000,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),

    CONSTRAINT uq_custom_model_user_name UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_custom_model_user_id ON custom_model (user_id);

-- RLS: each user can only see their own custom models
ALTER TABLE custom_model ENABLE ROW LEVEL SECURITY;
CREATE POLICY custom_model_user_isolation ON custom_model
    USING (user_id = current_setting('app.current_user_id', true));
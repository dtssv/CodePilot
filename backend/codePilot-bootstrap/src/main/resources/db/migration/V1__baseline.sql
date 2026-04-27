-- ============================================================================
--  CodePilot — Flyway baseline
--  Target: PostgreSQL 16+
--
--  IMPORTANT: This is the ONLY authoritative way to evolve the CodePilot
--  database schema. Do NOT modify existing V* files; add V2__*, V3__*, ...
--  See scripts/db/README.md for the full policy.
-- ============================================================================

-- == Extensions =============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS "citext";   -- case-insensitive user names

-- == Users & tenants ========================================================

CREATE TABLE IF NOT EXISTS tenants (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    slug          CITEXT      NOT NULL UNIQUE,
    name          TEXT        NOT NULL,
    enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    sso_subject   TEXT        NOT NULL,
    display_name  TEXT        NOT NULL,
    email         CITEXT      NOT NULL,
    status        TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, sso_subject)
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- == Devices (for HMAC signing) ============================================

CREATE TABLE IF NOT EXISTS devices (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id       TEXT        NOT NULL,
    device_secret   BYTEA       NOT NULL, -- KMS-wrapped
    os              TEXT        NOT NULL,
    app_version     TEXT        NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, device_id)
);

-- == Custom model providers (per-user, OpenAI-compatible) ==================

CREATE TABLE IF NOT EXISTS custom_model_providers (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT        NOT NULL,
    protocol      TEXT        NOT NULL CHECK (protocol IN ('openai','azure-openai','ollama','anthropic')),
    base_url      TEXT        NOT NULL,
    api_key_cipher BYTEA      NOT NULL, -- KMS-wrapped
    model         TEXT        NOT NULL,
    headers_json  JSONB       NOT NULL DEFAULT '{}'::jsonb,
    timeout_ms    INTEGER     NOT NULL DEFAULT 60000,
    enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, name)
);

-- == Idempotency keys (short-lived) ========================================

CREATE TABLE IF NOT EXISTS idempotency_keys (
    id          TEXT         PRIMARY KEY,
    scope       TEXT         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idem_expires ON idempotency_keys (expires_at);

-- == Trigger: auto-update updated_at =======================================

CREATE OR REPLACE FUNCTION trg_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind='r'
        AND c.relname IN ('tenants','users','custom_model_providers')
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %1$s_touch ON %1$s; '
      'CREATE TRIGGER %1$s_touch BEFORE UPDATE ON %1$s '
      'FOR EACH ROW EXECUTE PROCEDURE trg_touch_updated_at();', t);
  END LOOP;
END $$;
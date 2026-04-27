-- ============================================================================
--  MCP / Skill marketplace (system-signed only).
--  Note: ONLY user-installed records live on the client; the backend keeps
--        just enough metadata to support listing, updates, and re-install.
-- ============================================================================

CREATE TABLE IF NOT EXISTS mcp_packages (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    slug          TEXT        NOT NULL UNIQUE,
    name          TEXT        NOT NULL,
    type          TEXT        NOT NULL CHECK (type IN ('mcp','skill')),
    author        TEXT        NOT NULL,
    latest_version TEXT       NOT NULL,
    description   TEXT,
    homepage_url  TEXT,
    changelog_url TEXT,
    deprecated    BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mcp_versions (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    package_id    UUID        NOT NULL REFERENCES mcp_packages(id) ON DELETE CASCADE,
    version       TEXT        NOT NULL,
    manifest_json JSONB       NOT NULL,  -- safe subset; systemPrompt / examples excluded
    download_url  TEXT        NOT NULL,
    sha256        TEXT        NOT NULL,
    signature     TEXT        NOT NULL,  -- base64
    signed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (package_id, version)
);

CREATE INDEX IF NOT EXISTS idx_mcp_versions_pkg ON mcp_versions (package_id);

CREATE TABLE IF NOT EXISTS install_records (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    package_slug TEXT        NOT NULL,
    version      TEXT        NOT NULL,
    scope        TEXT        NOT NULL CHECK (scope IN ('project','global')),
    source       TEXT        NOT NULL CHECK (source IN ('official','third-party','local','builtin-ide')),
    installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    uninstalled_at TIMESTAMPTZ,
    UNIQUE (user_id, package_slug, version, scope, source)
);

CREATE INDEX IF NOT EXISTS idx_install_records_user ON install_records (user_id);

-- == Plugin update (release channel metadata) ==============================

CREATE TABLE IF NOT EXISTS plugin_releases (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    channel         TEXT        NOT NULL CHECK (channel LIKE 'stable' OR channel LIKE 'beta' OR channel LIKE 'dev' OR channel LIKE 'corp.%'),
    version         TEXT        NOT NULL,
    min_ide_build   TEXT        NOT NULL,
    max_ide_build   TEXT,
    manifest_json   JSONB       NOT NULL,  -- artifacts[] kind/sha256/signature/downloadUrl
    rollout_percent INTEGER     NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100),
    pin_to          TEXT,
    published_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (channel, version)
);

CREATE INDEX IF NOT EXISTS idx_plugin_releases_channel ON plugin_releases (channel);
-- ============================================================================
--  MCP / Skill marketplace + Plugin update channels.
--  Target: MySQL 8.0+
-- ============================================================================

CREATE TABLE IF NOT EXISTS mcp_packages (
    id             CHAR(36)     NOT NULL PRIMARY KEY,
    slug           VARCHAR(256) NOT NULL UNIQUE,
    name           VARCHAR(256) NOT NULL,
    type           ENUM('mcp','skill') NOT NULL,
    author         VARCHAR(128) NOT NULL,
    latest_version VARCHAR(32)  NOT NULL,
    description    TEXT,
    homepage_url   VARCHAR(1024),
    changelog_url  VARCHAR(1024),
    deprecated     TINYINT(1)   NOT NULL DEFAULT 0,
    created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mcp_versions (
    id             CHAR(36)     NOT NULL PRIMARY KEY,
    package_id     CHAR(36)     NOT NULL,
    version        VARCHAR(32)  NOT NULL,
    manifest_json  JSON         NOT NULL COMMENT 'safe subset; systemPrompt/examples excluded',
    download_url   VARCHAR(1024) NOT NULL,
    sha256         VARCHAR(64)  NOT NULL,
    signature      TEXT         NOT NULL COMMENT 'base64',
    signed_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_pkg_version (package_id, version),
    CONSTRAINT fk_version_pkg FOREIGN KEY (package_id) REFERENCES mcp_packages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_mcp_versions_pkg ON mcp_versions (package_id);

CREATE TABLE IF NOT EXISTS install_records (
    id             CHAR(36)     NOT NULL PRIMARY KEY,
    user_id        CHAR(36)     NOT NULL,
    package_slug   VARCHAR(256) NOT NULL,
    version        VARCHAR(32)  NOT NULL,
    scope          ENUM('project','global') NOT NULL,
    source         ENUM('official','third-party','local','builtin-ide') NOT NULL,
    installed_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    uninstalled_at DATETIME(3)  DEFAULT NULL,
    UNIQUE KEY uk_install (user_id, package_slug, version, scope, source),
    INDEX idx_install_user (user_id),
    CONSTRAINT fk_install_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- == Plugin update (release channel metadata) ==============================

CREATE TABLE IF NOT EXISTS plugin_releases (
    id              CHAR(36)     NOT NULL PRIMARY KEY,
    channel         VARCHAR(64)  NOT NULL COMMENT 'stable|beta|dev|corp.*',
    version         VARCHAR(32)  NOT NULL,
    min_ide_build   VARCHAR(32)  NOT NULL,
    max_ide_build   VARCHAR(32),
    manifest_json   JSON         NOT NULL COMMENT 'artifacts[] kind/sha256/signature/downloadUrl',
    rollout_percent TINYINT UNSIGNED NOT NULL DEFAULT 100,
    pin_to          VARCHAR(32),
    published_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_channel_version (channel, version),
    INDEX idx_plugin_rel_channel (channel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
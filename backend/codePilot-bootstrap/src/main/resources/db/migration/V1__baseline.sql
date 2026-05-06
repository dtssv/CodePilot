-- ============================================================================
--  CodePilot — Flyway baseline
--  Target: MySQL 8.0+
--
--  IMPORTANT: This is the ONLY authoritative way to evolve the CodePilot
--  database schema. Do NOT modify existing V* files; add V2__*, V3__*, ...
-- ============================================================================

-- == Users & tenants ========================================================

CREATE TABLE IF NOT EXISTS tenants (
    id            CHAR(36)     NOT NULL PRIMARY KEY,
    slug          VARCHAR(128) NOT NULL UNIQUE,
    name          VARCHAR(256) NOT NULL,
    enabled       TINYINT(1)   NOT NULL DEFAULT 1,
    created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
    id            CHAR(36)     NOT NULL PRIMARY KEY,
    tenant_id     CHAR(36)     NOT NULL,
    sso_subject   VARCHAR(256) NOT NULL,
    display_name  VARCHAR(256) NOT NULL,
    email         VARCHAR(320) NOT NULL,
    status        ENUM('active','suspended') NOT NULL DEFAULT 'active',
    created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_tenant_sso (tenant_id, sso_subject),
    INDEX idx_users_email (email),
    CONSTRAINT fk_users_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- == Devices (for HMAC signing) ============================================

CREATE TABLE IF NOT EXISTS devices (
    id              CHAR(36)       NOT NULL PRIMARY KEY,
    user_id         CHAR(36)       NOT NULL,
    device_id       VARCHAR(256)   NOT NULL,
    device_secret   VARBINARY(4096) NOT NULL,
    os              VARCHAR(32)    NOT NULL,
    app_version     VARCHAR(32)    NOT NULL,
    revoked_at      DATETIME(3)    DEFAULT NULL,
    created_at      DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_seen_at    DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_user_device (user_id, device_id),
    CONSTRAINT fk_devices_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- == Custom model providers (per-user, OpenAI-compatible) ==================

CREATE TABLE IF NOT EXISTS custom_model_providers (
    id             CHAR(36)       NOT NULL PRIMARY KEY,
    user_id        CHAR(36)       NOT NULL,
    name           VARCHAR(128)   NOT NULL,
    protocol       ENUM('openai','azure-openai','ollama','anthropic') NOT NULL,
    base_url       VARCHAR(1024)  NOT NULL,
    api_key_cipher VARBINARY(4096) NOT NULL,
    model          VARCHAR(128)   NOT NULL,
    headers_json   JSON           NOT NULL,
    timeout_ms     INT            NOT NULL DEFAULT 60000,
    enabled        TINYINT(1)     NOT NULL DEFAULT 1,
    created_at     DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at     DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_user_model_name (user_id, name),
    CONSTRAINT fk_models_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- == Idempotency keys (short-lived) ========================================

CREATE TABLE IF NOT EXISTS idempotency_keys (
    id          VARCHAR(128)  NOT NULL PRIMARY KEY,
    scope       VARCHAR(64)   NOT NULL,
    created_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    expires_at  DATETIME(3)   NOT NULL,
    INDEX idx_idem_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
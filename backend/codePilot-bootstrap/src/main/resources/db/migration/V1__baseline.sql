-- ============================================================================
--  CodePilot — Flyway baseline (single consolidated schema)
--  Target: MySQL 8.0+
--
--  This file is the ONE authoritative definition of the CodePilot database
--  schema. It merges every historical migration (former V1..V16) into a single
--  baseline that reflects the project's actual, current state:
--
--    * auth / tenancy            tenants, users, devices
--    * models                    custom_model_providers, system_model_providers,
--                                model_groups, model_app_keys
--    * RAG                        rag_chunks
--    * marketplace / updates     mcp_packages, mcp_versions, install_records,
--                                plugin_releases
--    * audit / security          audit_events, system_leak_events
--    * usage / quota             usage_records, usage_daily_quotas
--    * background / sharing      background_agent_tasks, conversation_shares
--    * durable runs              conversation_runs, conversation_run_events
--    * agent engine              agent_memories, agent_tasks, subagent_runs,
--                                workflow_runs, workflow_steps,
--                                agent_sessions, agent_messages, agent_envelopes
--
--  Obsolete objects from earlier migrations (task_tree, the pre-v2 agent_memories
--  shape, idempotency_keys) are NOT created here; see
--  db/cleanup/drop-obsolete.sql to remove them from an existing database.
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

-- == Devices (for HMAC signing) =============================================

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

-- == Models =================================================================

-- Per-user, OpenAI-compatible custom providers.
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

-- System-wide providers (admin-configured); read-only projection in the app.
CREATE TABLE IF NOT EXISTS system_model_providers (
    id              VARCHAR(36)     NOT NULL COMMENT '主键UUID',
    name            VARCHAR(128)    NOT NULL COMMENT '模型显示名称',
    protocol        VARCHAR(32)     NOT NULL COMMENT '协议类型: openai/azure-openai/ollama/anthropic',
    base_url        VARCHAR(512)    NOT NULL COMMENT '服务调用地址',
    api_key_cipher  VARBINARY(1024) NOT NULL COMMENT 'API Key (AES-256-GCM 加密存储)',
    model           VARCHAR(128)    NOT NULL COMMENT '模型标识 (如 gpt-4o-mini)',
    capabilities    VARCHAR(512)    NOT NULL DEFAULT '["tools","stream"]' COMMENT '模型能力列表 JSON数组',
    max_tokens      INT             NOT NULL DEFAULT 128000 COMMENT '最大token数',
    headers_json    JSON            NOT NULL COMMENT '额外请求头 JSON',
    timeout_ms      INT             NOT NULL DEFAULT 60000 COMMENT '请求超时毫秒数',
    enabled         TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '是否启用: 1=启用 0=禁用',
    sort_order      INT             NOT NULL DEFAULT 0 COMMENT '排序序号 (升序)',
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    UNIQUE KEY uk_system_model_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统模型配置表';

-- Model group: what the user sees (e.g. "glm-5.1", "gpt-4o").
CREATE TABLE IF NOT EXISTS model_groups (
    id              VARCHAR(36)     NOT NULL COMMENT '主键UUID',
    name            VARCHAR(128)    NOT NULL COMMENT '模型组显示名称 (如 glm-5.1)',
    protocol        VARCHAR(32)     NOT NULL COMMENT '协议类型: openai/azure-openai/ollama/anthropic',
    model           VARCHAR(128)    NOT NULL COMMENT '模型标识 (如 gpt-4o-mini)',
    base_url        VARCHAR(512)    NOT NULL COMMENT '默认服务调用地址 (appkey可覆盖)',
    capabilities    VARCHAR(512)    NOT NULL DEFAULT '["tools","stream"]' COMMENT '模型能力列表 JSON数组',
    max_tokens      INT             NOT NULL DEFAULT 128000 COMMENT '最大token数',
    headers_json    JSON            NOT NULL COMMENT '额外请求头 JSON',
    timeout_ms      INT             NOT NULL DEFAULT 60000 COMMENT '请求超时毫秒数',
    enabled         TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '是否启用: 1=启用 0=禁用',
    sort_order      INT             NOT NULL DEFAULT 0 COMMENT '排序序号 (升序)',
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    UNIQUE KEY uk_model_group_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='模型组配置表';

-- Model app key: individual API keys under a model group (load-balanced).
CREATE TABLE IF NOT EXISTS model_app_keys (
    id              VARCHAR(36)     NOT NULL COMMENT '主键UUID',
    group_id        VARCHAR(36)     NOT NULL COMMENT '所属模型组ID',
    name            VARCHAR(128)    NOT NULL COMMENT 'AppKey名称/备注 (如 官方key-1)',
    base_url        VARCHAR(512)    NULL COMMENT '覆盖模型组的base_url (NULL则用模型组的)',
    api_key_cipher  VARBINARY(1024) NOT NULL COMMENT 'API Key (AES-256-GCM 加密存储)',
    weight          INT             NOT NULL DEFAULT 1 COMMENT '权重 (负载均衡时使用)',
    enabled         TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '是否启用: 1=启用 0=禁用',
    max_concurrency INT             NOT NULL DEFAULT 0 COMMENT '最大并发数 (0=不限)',
    rpm_limit       INT             NOT NULL DEFAULT 0 COMMENT '每分钟请求数上限 (0=不限)',
    tpm_limit       INT             NOT NULL DEFAULT 0 COMMENT '每分钟Token数上限 (0=不限)',
    priority        INT             NOT NULL DEFAULT 0 COMMENT '优先级 (数值越大越优先)',
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    INDEX idx_appkey_group (group_id),
    CONSTRAINT fk_appkey_group FOREIGN KEY (group_id) REFERENCES model_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='模型AppKey配置表';

-- == RAG vector store (session-scoped, short TTL) ===========================

CREATE TABLE IF NOT EXISTS rag_chunks (
    id           BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    session_id   CHAR(36)     NOT NULL,
    user_id      CHAR(36)     NOT NULL,
    path         VARCHAR(1024) NOT NULL,
    lang         VARCHAR(32),
    start_line   INT,
    end_line     INT,
    content_hash VARCHAR(64)  NOT NULL COMMENT 'sha256 of the chunk content',
    snippet      TEXT         NOT NULL COMMENT 'redacted preview (<=4 KB)',
    embedding    BLOB         NOT NULL COMMENT '1536-dim float32 vector (6144 bytes)',
    created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    expires_at   DATETIME(3)  NOT NULL,
    INDEX idx_rag_session (session_id),
    INDEX idx_rag_expires (expires_at),
    INDEX idx_rag_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- == MCP / Skill marketplace + plugin update channels =======================

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
    INDEX idx_mcp_versions_pkg (package_id),
    CONSTRAINT fk_version_pkg FOREIGN KEY (package_id) REFERENCES mcp_packages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

-- == Audit & security =======================================================

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

-- == Usage & quota ==========================================================

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

-- == Background agents & conversation sharing ===============================

CREATE TABLE IF NOT EXISTS background_agent_tasks (
    id              CHAR(36)       NOT NULL PRIMARY KEY,
    status          VARCHAR(32)    NOT NULL DEFAULT 'queued',
    title           VARCHAR(256)   NOT NULL DEFAULT 'Background task',
    prompt          MEDIUMTEXT     NOT NULL,
    worktree_path   VARCHAR(1024)  NULL,
    local_task_id   VARCHAR(128)   NULL,
    branch_name     VARCHAR(256)   NULL,
    task_json       JSON           NOT NULL COMMENT 'Full task payload for plugin sync',
    created_at      DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at      DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    ended_at        DATETIME(3)    NULL,
    INDEX idx_bg_status (status),
    INDEX idx_bg_updated (updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversation_shares (
    id              CHAR(36)       NOT NULL PRIMARY KEY,
    title           VARCHAR(512)   NOT NULL DEFAULT 'CodePilot Share',
    format          VARCHAR(32)    NOT NULL DEFAULT 'markdown',
    content         MEDIUMTEXT     NOT NULL,
    created_at      DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    expires_at      DATETIME(3)    NOT NULL,
    revoked_at      DATETIME(3)    NULL,
    INDEX idx_share_expires (expires_at),
    INDEX idx_share_revoked (revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- == Durable conversation runs (survive rolling deploy via DB + reclaim) =====

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

-- ===========================================================================
--  Agent engine (session-centric, MiMo-parity)
-- ===========================================================================

-- 4-layer persistent memory + notes scratchpad. FULLTEXT(content) backs keyword
-- retrieval (MATCH ... AGAINST), mirroring the reference project's SQLite FTS5.
--   PERSISTENT/GLOBAL/CHECKPOINT/SESSION/NOTES/DISTILLED via memory_type.
CREATE TABLE IF NOT EXISTS agent_memories (
    id                 VARCHAR(64)   NOT NULL,
    memory_type        VARCHAR(32)   NOT NULL DEFAULT 'SESSION',
    content            MEDIUMTEXT    NOT NULL,
    session_id         VARCHAR(128)  NULL,
    project_id         VARCHAR(128)  NULL,
    importance         DOUBLE        NOT NULL DEFAULT 0.5,
    expires_at         DATETIME      NULL,
    source_session_id  VARCHAR(128)  NULL,
    created_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    FULLTEXT INDEX idx_memory_ft (content),
    INDEX idx_memory_project (project_id, memory_type),
    INDEX idx_memory_session (session_id),
    INDEX idx_memory_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Persistent 4-layer agent memory';

-- Tree-shaped task hierarchy (T1, T1.1, ...). status: pending/in_progress/completed/failed.
CREATE TABLE IF NOT EXISTS agent_tasks (
    id            VARCHAR(64)  NOT NULL,
    parent_id     VARCHAR(64)  NULL,
    session_id    VARCHAR(64)  NOT NULL,
    title         VARCHAR(512) NOT NULL,
    description   TEXT         NULL,
    status        VARCHAR(32)  NOT NULL DEFAULT 'pending',
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_task_session (session_id),
    INDEX idx_task_parent (parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Subagent run persistence (parallel / background subagents).
CREATE TABLE IF NOT EXISTS subagent_runs (
    task_id           VARCHAR(128) NOT NULL PRIMARY KEY,
    parent_session_id VARCHAR(128) NOT NULL,
    child_session_id  VARCHAR(128),
    description       TEXT,
    agent_name        VARCHAR(64) DEFAULT 'general',
    status            ENUM('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED','IDLE') DEFAULT 'PENDING',
    result            TEXT,
    background        BOOLEAN DEFAULT FALSE,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at      DATETIME NULL,
    INDEX idx_subagent_parent (parent_session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Dynamic workflow: LLM-generated scripts + per-step memo (crash recovery).
CREATE TABLE IF NOT EXISTS workflow_runs (
    id           VARCHAR(64)   NOT NULL,
    session_id   VARCHAR(128)  NULL,
    user_id      VARCHAR(64)   NULL,
    goal         MEDIUMTEXT    NULL,
    script       MEDIUMTEXT    NULL,
    status       VARCHAR(32)   NOT NULL DEFAULT 'RUNNING',
    result       MEDIUMTEXT    NULL,
    error        TEXT          NULL,
    created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_workflow_session (session_id),
    INDEX idx_workflow_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Dynamic workflow runs';

CREATE TABLE IF NOT EXISTS workflow_steps (
    id           VARCHAR(64)   NOT NULL,
    workflow_id  VARCHAR(64)   NOT NULL,
    step_key     VARCHAR(191)  NOT NULL,
    agent_name   VARCHAR(64)   NULL,
    input        MEDIUMTEXT    NULL,
    output       MEDIUMTEXT    NULL,
    status       VARCHAR(32)   NOT NULL DEFAULT 'PENDING',
    created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_workflow_step (workflow_id, step_key),
    INDEX idx_wstep_wf (workflow_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Dynamic workflow step memo (crash recovery)';

-- Session runtime: durable header + transcript + v2 SSE envelope log (replay).
CREATE TABLE IF NOT EXISTS agent_sessions (
    id              VARCHAR(64)  NOT NULL,
    user_id         VARCHAR(64)  NULL,
    model_id        VARCHAR(64)  NULL,
    model_source    VARCHAR(32)  NULL,
    status          VARCHAR(32)  NULL,
    current_agent   VARCHAR(64)  NULL,
    goal_condition  TEXT         NULL,
    session_json    LONGTEXT     NULL,
    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_session_user (user_id),
    INDEX idx_session_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_messages (
    id              VARCHAR(64)  NOT NULL,
    session_id      VARCHAR(64)  NULL,
    role            VARCHAR(16)  NULL,
    content         TEXT         NULL,
    tool_calls_json JSON         NULL,
    tool_call_id    VARCHAR(64)  NULL,
    tool_name       VARCHAR(64)  NULL,
    thinking        TEXT         NULL,
    usage_json      JSON         NULL,
    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_message_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_envelopes (
    session_id      VARCHAR(64)  NOT NULL,
    seq             INT          NOT NULL,
    turn_id         VARCHAR(64)  NULL,
    step_id         VARCHAR(64)  NULL,
    type            VARCHAR(64)  NULL,
    payload_json    JSON         NULL,
    ts              BIGINT       NULL,
    PRIMARY KEY (session_id, seq),
    INDEX idx_envelope_session_seq (session_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================================
--  Demo seed (idempotent; safe to keep in dev/staging baselines)
-- ===========================================================================

INSERT IGNORE INTO tenants (id, slug, name)
VALUES ('00000000-0000-0000-0000-00000000dev0', 'dev', 'Developer tenant');

INSERT IGNORE INTO users (id, tenant_id, sso_subject, display_name, email)
VALUES (
  '00000000-0000-0000-0000-00000000deva',
  '00000000-0000-0000-0000-00000000dev0',
  'developer',
  'Developer',
  'developer@local.dev'
);

INSERT IGNORE INTO mcp_packages (id, slug, name, type, author, latest_version, description)
VALUES
  (UUID(), 'skill.lang.java', 'Java language profile', 'skill', 'codePilot-core', '1.0.0',
   'Idiomatic guidance for Java projects: code style, exception handling, Spring conventions.'),
  (UUID(), 'skill.action.refactor', 'Refactor action skill', 'skill', 'codePilot-core', '1.0.0',
   'Drives the Refactor selection action end-to-end.');

-- Marketplace versions are marked source=official (installable IDE-side).
INSERT IGNORE INTO mcp_versions (id, package_id, version, manifest_json, download_url, sha256, signature)
SELECT UUID(), p.id, '1.0.0',
       JSON_OBJECT(
         'id',     p.slug,
         'source', 'official',
         'version','1.0.0',
         'title',  p.name,
         'triggersBrief', JSON_ARRAY(JSON_OBJECT('language', JSON_ARRAY('java'))),
         'permissionsBrief', JSON_OBJECT('tools', JSON_ARRAY('fs.read','fs.replace'), 'risk', JSON_ARRAY('low','medium')),
         'audit', JSON_OBJECT('tokensEstimate', 260),
         'changelogUrl', CONCAT('https://docs.codepilot.local/skills/', p.slug, '/CHANGELOG')
       ),
       '', '', ''
  FROM mcp_packages p WHERE p.slug IN ('skill.lang.java','skill.action.refactor');

INSERT IGNORE INTO plugin_releases (id, channel, version, min_ide_build, manifest_json, rollout_percent)
VALUES (
  UUID(),
  'stable',
  '1.0.0',
  '232',
  JSON_OBJECT(
    'artifacts', JSON_ARRAY(
      JSON_OBJECT(
        'kind',     'full',
        'url',      'https://downloads.codepilot.local/plugin/1.0.0/codePilot-1.0.0.zip',
        'sha256',   '0000000000000000000000000000000000000000000000000000000000000000',
        'signature','',
        'size',     12800000,
        'covers',   JSON_ARRAY('bundle')
      )
    ),
    'changelogUrl', 'https://docs.codepilot.local/release/1.0.0'
  ),
  100
);

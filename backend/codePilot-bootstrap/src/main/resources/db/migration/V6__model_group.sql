-- ============================================================
-- V6: Model Group & AppKey tables
-- Introduces the concept of "model groups" that group multiple
-- API keys for the same model. The system exposes model groups
-- to users while load-balancing across app keys internally.
-- ============================================================

-- Model group: what the user sees (e.g. "glm-5.1", "gpt-4o")
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

-- Model app key: individual API keys under a model group
CREATE TABLE IF NOT EXISTS model_app_keys (
    id              VARCHAR(36)     NOT NULL COMMENT '主键UUID',
    group_id        VARCHAR(36)     NOT NULL COMMENT '所属模型组ID',
    name            VARCHAR(128)    NOT NULL COMMENT 'AppKey名称/备注 (如 官方key-1)',
    base_url        VARCHAR(512)    NULL COMMENT '覆盖模型组的base_url (NULL则用模型组的)',
    api_key_cipher  VARBINARY(1024) NOT NULL COMMENT 'API Key (AES-256-GCM 加密存储)',
    weight          INT             NOT NULL DEFAULT 1 COMMENT '权重 (负载均衡时使用)',
    enabled         TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '是否启用: 1=启用 0=禁用',
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    max_concurrency INT    NOT NULL DEFAULT 0     COMMENT '最大并发数 (0=不限)',
    rpm_limit       INT    NOT NULL DEFAULT 0     COMMENT '每分钟请求数上限 (0=不限)',
    tpm_limit       INT    NOT NULL DEFAULT 0     COMMENT '每分钟Token数上限 (0=不限)',
    priority        INT    NOT NULL DEFAULT 0     COMMENT '优先级 (数值越大越优先, 同负载时优先选高优先级)',
    PRIMARY KEY (id),
    INDEX idx_appkey_group (group_id),
    CONSTRAINT fk_appkey_group FOREIGN KEY (group_id) REFERENCES model_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='模型AppKey配置表';

-- Migrate existing system_model_providers data into model_groups + model_app_keys
-- Each existing system model becomes a model group with its single api key as an app key
INSERT INTO model_groups (id, name, protocol, model, base_url, capabilities, max_tokens, headers_json, timeout_ms, enabled, sort_order, created_at, updated_at)
SELECT id, name, protocol, model, base_url, capabilities, max_tokens, headers_json, timeout_ms, enabled, sort_order, created_at, updated_at
FROM system_model_providers;

INSERT INTO model_app_keys (id, group_id, name, base_url, api_key_cipher, weight, enabled, created_at, updated_at)
SELECT UUID(), id, CONCAT(name, '-default'), NULL, api_key_cipher, 1, 1, created_at, updated_at
FROM system_model_providers;
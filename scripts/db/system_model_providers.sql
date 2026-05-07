-- ============================================================================
--  CodePilot — system_model_providers 表 (MySQL 8.0+)
--  系统模型由管理员配置，所有用户可用
-- ============================================================================

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

-- ============================================================================
--  同步修改 custom_model_providers 表为 MySQL 语法 (如已存在可忽略)
-- ============================================================================

CREATE TABLE IF NOT EXISTS custom_model_providers (
    id              VARCHAR(36)     NOT NULL COMMENT '主键UUID',
    user_id         VARCHAR(36)     NOT NULL COMMENT '所属用户ID',
    name            VARCHAR(128)    NOT NULL COMMENT '模型显示名称',
    protocol        VARCHAR(32)     NOT NULL COMMENT '协议类型: openai/azure-openai/ollama/anthropic',
    base_url        VARCHAR(512)    NOT NULL COMMENT '服务调用地址',
    api_key_cipher  VARBINARY(1024) NOT NULL COMMENT 'API Key (AES-256-GCM 加密存储)',
    model           VARCHAR(128)    NOT NULL COMMENT '模型标识',
    headers_json    JSON            NOT NULL COMMENT '额外请求头 JSON',
    timeout_ms      INT             NOT NULL DEFAULT 60000 COMMENT '请求超时毫秒数',
    enabled         TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '是否启用',
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    UNIQUE KEY uk_custom_model_user_name (user_id, name),
    KEY idx_custom_model_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户自定义模型配置表';

-- ============================================================================
--  初始化默认系统模型 (示例, 按实际环境修改 base_url 和 api_key_cipher)
-- ============================================================================
-- INSERT INTO system_model_providers (id, name, protocol, base_url, api_key_cipher, model, capabilities, max_tokens, sort_order)
-- VALUES
--   (UUID(), 'CodePilot Default', 'openai', 'https://api.openai.com/v1', <encrypted_key>, 'gpt-4o-mini', '["tools","stream"]', 128000, 1),
--   (UUID(), 'CodePilot Pro', 'openai', 'https://api.openai.com/v1', <encrypted_key>, 'gpt-4o', '["tools","stream","vision"]', 200000, 2);
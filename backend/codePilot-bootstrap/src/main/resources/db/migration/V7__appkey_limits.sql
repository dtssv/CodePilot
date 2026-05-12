-- ============================================================
-- V7: Add rate-limit and priority fields to model_app_keys
-- Each app key can now declare its own concurrency limit,
-- RPM/TPM quotas, and priority for load-balancing decisions.
-- ============================================================

ALTER TABLE model_app_keys
    ADD COLUMN max_concurrency INT    NOT NULL DEFAULT 0     COMMENT '最大并发数 (0=不限)',
    ADD COLUMN rpm_limit       INT    NOT NULL DEFAULT 0     COMMENT '每分钟请求数上限 (0=不限)',
    ADD COLUMN tpm_limit       INT    NOT NULL DEFAULT 0     COMMENT '每分钟Token数上限 (0=不限)',
    ADD COLUMN priority        INT    NOT NULL DEFAULT 0     COMMENT '优先级 (数值越大越优先, 同负载时优先选高优先级)';
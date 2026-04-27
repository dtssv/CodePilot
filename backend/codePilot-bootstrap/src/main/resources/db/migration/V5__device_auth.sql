-- V5: device_auth — support for OIDC Device Code Flow (RFC 8628)
-- Stores server-side device_code state for the auth proxy.
-- In practice, the primary store is Redis (short TTL); this table serves as
-- an audit trail and fallback for admin queries.

CREATE TABLE IF NOT EXISTS device_auth (
    id              BIGSERIAL       PRIMARY KEY,
    device_code_key VARCHAR(64)     NOT NULL,  -- our key (UUID), given to plugin
    idp_device_code VARCHAR(256)    NOT NULL,  -- IdP-returned device_code (encrypted at rest in future)
    user_code       VARCHAR(32)     NOT NULL,  -- the code the user enters in the browser
    verification_uri TEXT           NOT NULL,  -- the URL the user visits
    client_id       VARCHAR(256)    NOT NULL,  -- OIDC client_id used
    status          VARCHAR(16)     NOT NULL DEFAULT 'pending',  -- pending | authorized | expired | error
    idp_id_token_hash VARCHAR(128),  -- sha256 of the id_token (never store the token itself)
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ     NOT NULL,  -- when this device_code expires
    authorized_at   TIMESTAMPTZ,    -- when the user completed authorization
    tenant_id       VARCHAR(64)     NOT NULL DEFAULT 'default'
);

CREATE INDEX idx_device_auth_key ON device_auth (device_code_key);
CREATE INDEX idx_device_auth_user_code ON device_auth (user_code);
CREATE INDEX idx_device_auth_status ON device_auth (status) WHERE status = 'pending';
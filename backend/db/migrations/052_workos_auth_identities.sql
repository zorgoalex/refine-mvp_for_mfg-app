-- 052_workos_auth_identities.sql
-- Hybrid external auth (WorkOS AuthKit): linked provider identities,
-- per-user login policy, and provider session id for provider-side logout.

BEGIN;

CREATE TABLE IF NOT EXISTS user_identities (
    identity_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    email_at_link CITEXT NOT NULL,
    email_verified_at_link BOOLEAN NOT NULL,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ,
    CONSTRAINT uq_user_identities_provider_sub UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS login_policy TEXT NOT NULL DEFAULT 'both'
  CHECK (login_policy IN ('local', 'external', 'both'));

ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS provider_session_id TEXT;

COMMIT;

-- 126_workos_user_controls.sql
-- Per-user WorkOS allow-list controls and one-time administrator invitations.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS workos_self_link_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS workos_self_unlink_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS workos_link_invitations (
    invitation_id UUID PRIMARY KEY,
    target_user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_by_user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT ck_workos_link_invitations_token_hash
      CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_workos_link_invitations_expiry
      CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_workos_link_invitations_target
  ON workos_link_invitations(target_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workos_link_invitations_active
  ON workos_link_invitations(target_user_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

COMMIT;

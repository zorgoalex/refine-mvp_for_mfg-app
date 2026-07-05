-- 055_user_identity_auth_method.sql
-- Sub-provider of each WorkOS identity (authentication_method: Password /
-- GoogleOAuth / MicrosoftOAuth / MagicAuth) — lets a human tell a "work"
-- link from a "personal" one in the identity list.

BEGIN;

ALTER TABLE user_identities
  ADD COLUMN IF NOT EXISTS auth_method TEXT;

COMMIT;

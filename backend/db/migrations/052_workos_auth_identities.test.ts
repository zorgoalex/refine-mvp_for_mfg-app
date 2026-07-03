import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./052_workos_auth_identities.sql', import.meta.url), 'utf8');

describe('052_workos_auth_identities migration', () => {
  it('creates the user_identities table keyed by provider identity', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS user_identities/i);
    expect(sql).toMatch(/user_id BIGINT NOT NULL REFERENCES users\(user_id\) ON DELETE CASCADE/i);
    expect(sql).toMatch(/CONSTRAINT uq_user_identities_provider_sub UNIQUE \(provider, provider_user_id\)/i);
    expect(sql).toMatch(/email_at_link CITEXT NOT NULL/i);
    expect(sql).toMatch(/email_verified_at_link BOOLEAN NOT NULL/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities\(user_id\)/i);
  });

  it('adds a constrained login_policy column defaulting to both', () => {
    expect(sql).toMatch(/ALTER TABLE users/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS login_policy TEXT NOT NULL DEFAULT 'both'/i);
    expect(sql).toMatch(/CHECK \(login_policy IN \('local', 'external', 'both'\)\)/i);
  });

  it('adds provider_session_id to auth_sessions for provider-side logout', () => {
    expect(sql).toMatch(/ALTER TABLE auth_sessions/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS provider_session_id TEXT/i);
  });
});

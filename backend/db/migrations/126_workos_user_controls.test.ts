import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./126_workos_user_controls.sql', import.meta.url), 'utf8');

describe('126_workos_user_controls migration', () => {
  it('adds independent per-user self-link and self-unlink controls with compatible defaults', () => {
    expect(sql).toMatch(/workos_self_link_enabled BOOLEAN NOT NULL DEFAULT TRUE/i);
    expect(sql).toMatch(/workos_self_unlink_enabled BOOLEAN NOT NULL DEFAULT TRUE/i);
  });

  it('stores only a hashed one-time invitation token and its lifecycle', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS workos_link_invitations/i);
    expect(sql).toMatch(/token_hash TEXT NOT NULL UNIQUE/i);
    expect(sql).toMatch(/expires_at TIMESTAMPTZ NOT NULL/i);
    expect(sql).toMatch(/consumed_at TIMESTAMPTZ/i);
    expect(sql).toMatch(/revoked_at TIMESTAMPTZ/i);
    expect(sql).not.toMatch(/\btoken TEXT\b/i);
  });

  it('is transactional and preserves referential cleanup', () => {
    expect(sql).toMatch(/BEGIN;/i);
    expect(sql).toMatch(/target_user_id BIGINT NOT NULL REFERENCES users\(user_id\) ON DELETE CASCADE/i);
    expect(sql).toMatch(/COMMIT;/i);
  });
});

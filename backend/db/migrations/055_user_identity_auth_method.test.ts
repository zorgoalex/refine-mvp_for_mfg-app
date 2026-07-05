import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./055_user_identity_auth_method.sql', import.meta.url), 'utf8');

describe('055_user_identity_auth_method migration', () => {
  it('adds a nullable auth_method column to user_identities', () => {
    expect(sql).toMatch(/ALTER TABLE user_identities/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS auth_method TEXT/i);
  });

  it('is wrapped in a transaction', () => {
    expect(sql).toMatch(/BEGIN;/i);
    expect(sql).toMatch(/COMMIT;/i);
  });
});

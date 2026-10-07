import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Access groups, stage 0A: a user's effective authorization has ONE source — `user_authorization_snapshot`
 * (PermissionsService.loadUserAuthorization, user-authorization-snapshot.ts) and the effective-permission views.
 * The static role matrix and direct reads of role grants are allowed only in the permissions core and in the
 * explicitly listed places below.
 */
const ROOT = join(__dirname, '..');
const PATTERN = /\b(ROLE_POLICIES|ROLE_PERMISSIONS|getPermissionsForRole)\b|\brole_permissions\b|\brole_policy_scopes\b/;

const ALLOWED: Record<string, string> = {
  'permissions/permissions.ts': 'static matrix definition and seed defaults',
  'permissions/permissions.service.ts': 'roles matrix administration and seeding',
  'permissions/policies/role-policies.ts': 'static scope defaults',
  'permissions/policies/scope.ts': 'fallback for tokens without scopes (role defaults)',
  'modules/auth/auth.service.ts': 'fallback only when no database is configured (unit tests)',
  'modules/auth/adapters/pg-auth-session-manager.ts': 'fallback only when no database is configured',
  'modules/users/adapters/pg-user-repository.ts': 'fallback only when no database is configured',
  'modules/production-actions/adapters/pg-production-action-repository.ts': 'system actor of deadline actions',
  'modules/payments-onec/domain/onec-receipts.ts': 'comment only',
  // Temporary: the WhatsApp session moves OrderSendActors to loadUserAuthorization in its own commit.
  'modules/whatsapp/order-send/order-send-actors.ts': 'TEMPORARY — to be switched by the WhatsApp session',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'testing' ? [] : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.(test|spec|integration)\.ts$/.test(name) && !/\.integration\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe('one source of effective authorization (access groups stage 0A)', () => {
  it('the static role matrix and direct role-grant reads appear only in the allowed places', () => {
    const offenders = sourceFiles(ROOT)
      .map((path) => relative(ROOT, path))
      .filter((path) => PATTERN.test(readFileSync(join(ROOT, path), 'utf8')))
      .filter((path) => !(path in ALLOWED));
    expect(offenders).toEqual([]);
  });

  it('every allowed place still exists (stale entries are removed)', () => {
    for (const path of Object.keys(ALLOWED)) {
      expect(PATTERN.test(readFileSync(join(ROOT, path), 'utf8')), path).toBe(true);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWLIST: Record<string, number> = {
  'src/common/audit/audit.service.ts': 1, // sole sanctioned central writer
  // Auth special-case: persists ip_address/user_agent absent from the central insert.
  'src/modules/auth/adapters/pg-auth-audit-repository.ts': 1,
  'src/modules/auth/adapters/pg-auth-session-manager.ts': 2,
  // WorkOS identity events share the identity insert/delete transaction and
  // persist ip_address/user_agent like the other auth writers. 4 writers:
  // link_failed, linked, mass-unlinked, and per-identity delete-one unlinked.
  'src/modules/auth/workos/pg-user-identity-repository.ts': 4,
  // DEFERRED Variant-B; remove each when its module is migrated.
  'src/modules/orders/adapters/pg-order-group-link-repository.ts': 1,
  'src/modules/orders/adapters/pg-order-transaction-manager.ts': 1,
  'src/modules/deadlines/adapters/pg-deadline-repository.ts': 2,
};

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}
const rawCount = (s: string) => (s.match(/INSERT\s+INTO\s+audit_log\b/gi) ?? []).length; // \b excludes audit_log_related_entity

// Anchor the scan to backend/src via this file's own location so the count is
// cwd-independent (this test runs under both the backend config AND the root
// vitest config; a cwd-relative 'src' scans the frontend tree under the latter).
const SRC_ROOT = join(__dirname, '..', '..'); // backend/src/common/audit -> backend/src

describe('audit_log raw writes are centralized + redacted (exact per-file counts)', () => {
  const counts = new Map<string, number>();
  for (const f of walk(SRC_ROOT)) { const n = rawCount(readFileSync(f, 'utf8')); if (n > 0) counts.set(f.replace(/\\/g, '/'), n); }

  it('every non-allowlisted file has zero raw audit_log writers', () => {
    const offenders = [...counts.keys()].filter((rel) => !Object.keys(ALLOWLIST).some((a) => rel.endsWith(a)));
    expect(offenders).toEqual([]);
  });
  it('every allowlisted file matches its exact expected count (fail on drift)', () => {
    for (const [allow, expected] of Object.entries(ALLOWLIST)) {
      const hit = [...counts.entries()].find(([rel]) => rel.endsWith(allow));
      expect(hit?.[1] ?? 0, `raw audit_log writer drift in ${allow}`).toBe(expected);
    }
  });
});

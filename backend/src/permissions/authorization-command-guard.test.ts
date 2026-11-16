import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../database/database.types';
import { assertAdministrationRemains, lockAuthorizationState } from './authorization-command-guard';

function client(row: { version: number; financials: string | null }) {
  const queries: string[] = [];
  const db = {
    query: async (text: string) => {
      queries.push(text);
      return { rows: [row], rowCount: 1 };
    },
  } as unknown as DatabaseClient;
  return { db, queries };
}

describe('lockAuthorizationState (step 1 of every authorization command)', () => {
  it('locks permissions_state and returns the version', async () => {
    const { db, queries } = client({ version: 7, financials: 'closed' });
    await expect(lockAuthorizationState(db, 'update')).resolves.toBe(7);
    expect(queries[0]).toContain('FROM permissions_state WHERE id = true FOR UPDATE');
  });

  it('refuses every authorization change while a revert of the Hasura step F2 runs (no one may lose the money right)', async () => {
    const { db } = client({ version: 7, financials: 'reverting' });
    await expect(lockAuthorizationState(db, 'update')).rejects.toMatchObject({ statusCode: 409, code: 'AUTHORIZATION_CHANGES_PAUSED' });
  });

  it('lets commands that only depend on authorization (share lock) run during the revert', async () => {
    const { db, queries } = client({ version: 7, financials: 'reverting' });
    await expect(lockAuthorizationState(db, 'share')).resolves.toBe(7);
    expect(queries[0]).toContain('FOR SHARE');
  });

  it('works on a database without migration 258 (no state: open)', async () => {
    const { db } = client({ version: 3, financials: null });
    await expect(lockAuthorizationState(db, 'update')).resolves.toBe(3);
  });
});

describe('assertAdministrationRemains (lockout, access groups plan R7 §5)', () => {
  const guard = (row: { remains: boolean; by_role?: boolean }) =>
    assertAdministrationRemains({ query: async () => ({ rows: [row], rowCount: 1 }) } as unknown as DatabaseClient);

  it('passes while an administrator remains (by role too while groups are on)', async () => {
    await expect(guard({ remains: true, by_role: true })).resolves.toBeUndefined();
  });

  it('refuses when nobody administers by effective rights', async () => {
    await expect(guard({ remains: false, by_role: true })).rejects.toMatchObject({ statusCode: 409, code: 'PERMISSIONS_LOCKOUT_DENIED' });
  });

  it('refuses when administration remains only through access groups (flag-off rollback would lock everyone out)', async () => {
    await expect(guard({ remains: true, by_role: false })).rejects.toMatchObject({
      statusCode: 409, code: 'PERMISSIONS_LOCKOUT_DENIED', details: expect.objectContaining({ byRole: true }),
    });
  });
});

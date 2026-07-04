import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { PgUserIdentityRepository, type IdentityActor } from './pg-user-identity-repository';

const ACTOR: IdentityActor = {
  userId: '42',
  username: 'manager',
  roleId: 10,
  requestId: 'req-1',
};

describe('PgUserIdentityRepository.insertLinkWithAudit', () => {
  const input = {
    actor: ACTOR,
    provider: 'workos',
    providerUserId: 'sub-a',
    emailAtLink: 'a@example.com',
    emailVerified: true,
    mode: 'self_serve' as const,
    sessionId: 'session-1',
  };

  it('locks session and user FOR UPDATE before the insert and audits in the same tx', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] }, // session lock
      { rows: [{ '?column?': 1 }] }, // user lock
      { rows: [{ identity_id: '1', user_id: '42', provider: 'workos', provider_user_id: 'sub-a', email_at_link: 'a@example.com' }] },
    ]);
    const repository = new PgUserIdentityRepository(database.service);

    const outcome = await repository.insertLinkWithAudit(input);

    expect(outcome.status).toBe('linked');
    // Snapshot EXISTS guards are NOT enough under READ COMMITTED — the
    // liveness proofs must be lock-based in the same transaction.
    expect(database.queries[0].text).toContain("status = 'active'");
    expect(database.queries[0].text).toContain('expires_at > now()');
    expect(database.queries[0].text).toContain('FOR UPDATE');
    expect(database.queries[1].text).toContain('is_active');
    expect(database.queries[1].text).toContain('FOR UPDATE');
    expect(database.queries[2].text).toContain('ON CONFLICT (provider, provider_user_id) DO NOTHING');
    expect(database.queries[3].text).toContain('auth.identity.linked');
    // Query-ready audit dimension (plan §4.8): the affected user.
    expect(database.queries[3].text).toContain('related_user_id');
    expect(database.queries[3].params[4]).toBe(42);
  });

  it('denies as session_inactive under lock when the session died mid-flight — no insert happens', async () => {
    const database = createTransactionalDatabase([
      { rows: [] }, // session lock finds no live row
    ]);
    const repository = new PgUserIdentityRepository(database.service);

    await expect(repository.insertLinkWithAudit(input)).resolves.toEqual({
      status: 'session_inactive',
    });
    expect(database.queries.filter((query) => query.text.includes('INSERT INTO user_identities'))).toHaveLength(0);
    expect(database.queries.filter((query) => query.text.includes('audit_log'))).toHaveLength(0);
  });

  it('denies as user_inactive under lock when the user was deactivated mid-flight', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] }, // session ok
      { rows: [] }, // user lock finds no active row
    ]);
    const repository = new PgUserIdentityRepository(database.service);

    await expect(repository.insertLinkWithAudit(input)).resolves.toEqual({
      status: 'user_inactive',
    });
    expect(database.queries.filter((query) => query.text.includes('INSERT INTO user_identities'))).toHaveLength(0);
  });

  it('resolves a concurrent conflict deterministically: same user → already_linked, other user → conflict', async () => {
    const sameUser = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] }, // session lock
      { rows: [{ '?column?': 1 }] }, // user lock
      { rows: [] }, // conflicting insert
      { rows: [{ identity_id: '1', user_id: '42', provider: 'workos', provider_user_id: 'sub-a', email_at_link: 'a@example.com' }] },
    ]);
    await expect(
      new PgUserIdentityRepository(sameUser.service).insertLinkWithAudit(input),
    ).resolves.toMatchObject({ status: 'already_linked' });

    const otherUser = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] },
      { rows: [{ '?column?': 1 }] },
      { rows: [] },
      { rows: [{ identity_id: '1', user_id: '99', provider: 'workos', provider_user_id: 'sub-a', email_at_link: 'a@example.com' }] },
    ]);
    await expect(
      new PgUserIdentityRepository(otherUser.service).insertLinkWithAudit(input),
    ).resolves.toEqual({ status: 'conflict', conflictUserId: '99' });
  });

  it('skips the session lock for admin_bulk provisioning without a session', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] }, // user lock only
      { rows: [{ identity_id: '1', user_id: '42', provider: 'workos', provider_user_id: 'sub-a', email_at_link: 'a@example.com' }] },
    ]);
    const repository = new PgUserIdentityRepository(database.service);

    await expect(
      repository.insertLinkWithAudit({ ...input, sessionId: undefined, mode: 'admin_bulk' }),
    ).resolves.toMatchObject({ status: 'linked' });
    expect(database.queries[0].text).not.toContain('auth_sessions');
    expect(database.queries[0].text).toContain('is_active');
  });
});

describe('PgUserIdentityRepository.deleteLinkWithAudit', () => {
  it('re-proves the live session under lock in the delete tx and audits PER deleted identity', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] }, // session lock
      { rows: [{ '?column?': 1 }] }, // user lock
      {
        rows: [
          { identity_id: '1', provider_user_id: 'sub-a', email_at_link: 'a@example.com' },
          { identity_id: '2', provider_user_id: 'sub-b', email_at_link: 'b@example.com' },
        ],
      },
    ]);
    const repository = new PgUserIdentityRepository(database.service);

    await expect(
      repository.deleteLinkWithAudit({ actor: ACTOR, provider: 'workos', sessionId: 'session-1' }),
    ).resolves.toBe('unlinked');

    expect(database.queries[0].text).toContain('FOR UPDATE');
    expect(database.queries[0].text).toContain("status = 'active'");
    const auditInserts = database.queries.filter((query) =>
      query.text.includes('auth.identity.unlinked'),
    );
    expect(auditInserts).toHaveLength(2);
    expect(JSON.stringify(auditInserts[0].params)).toContain('sub-a');
    expect(JSON.stringify(auditInserts[1].params)).toContain('sub-b');
    for (const insert of auditInserts) {
      expect(insert.text).toContain('related_user_id');
      expect(insert.params[4]).toBe(42);
    }
  });

  it('refuses to unlink when the session died between the pre-check and the delete', async () => {
    const database = createTransactionalDatabase([
      { rows: [] }, // session lock finds no live row
    ]);
    const repository = new PgUserIdentityRepository(database.service);

    await expect(
      repository.deleteLinkWithAudit({ actor: ACTOR, provider: 'workos', sessionId: 'session-1' }),
    ).resolves.toBe('session_inactive');
    expect(database.queries.filter((query) => query.text.includes('DELETE FROM user_identities'))).toHaveLength(0);
    expect(database.queries.filter((query) => query.text.includes('audit_log'))).toHaveLength(0);
  });

  it('refuses to unlink when the policy flipped to external-only during bcrypt (locked re-check)', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] }, // session lock
      { rows: [{ login_policy: 'external' }] }, // user lock sees the flip
    ]);
    const repository = new PgUserIdentityRepository(database.service);

    await expect(
      repository.deleteLinkWithAudit({ actor: ACTOR, provider: 'workos', sessionId: 'session-1' }),
    ).resolves.toBe('external_policy');
    expect(database.queries.filter((query) => query.text.includes('DELETE FROM user_identities'))).toHaveLength(0);
  });

  it('returns not_linked and writes no audit when nothing was linked', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] }, // session lock
      { rows: [{ '?column?': 1 }] }, // user lock
      { rows: [] }, // delete found nothing
    ]);
    const repository = new PgUserIdentityRepository(database.service);

    await expect(
      repository.deleteLinkWithAudit({ actor: ACTOR, provider: 'workos', sessionId: 'session-1' }),
    ).resolves.toBe('not_linked');
    expect(database.queries.filter((query) => query.text.includes('audit_log'))).toHaveLength(0);
  });
});

describe('PgUserIdentityRepository.writeLinkFailed', () => {
  it('writes the affected user into related_user_id (query-ready, plan §4.8)', async () => {
    const database = createTransactionalDatabase([{ rows: [] }]);
    const repository = new PgUserIdentityRepository(database.service);

    await repository.writeLinkFailed({
      actor: ACTOR,
      reason: 'identity_conflict',
      provider: 'workos',
      providerUserId: 'sub-a',
      conflictUserId: '99',
    });

    const insert = database.queries[0];
    expect(insert.text).toContain('auth.identity.link_failed');
    expect(insert.text).toContain('related_user_id');
    expect(insert.params[4]).toBe(42);
    const metadata = JSON.parse(String(insert.params[8])) as Record<string, unknown>;
    expect(metadata).toMatchObject({ reason: 'identity_conflict', conflictUserId: '99' });
  });
});

describe('PgUserIdentityRepository.isSessionActive', () => {
  it('requires an active, unexpired auth_sessions row', async () => {
    const database = createTransactionalDatabase([{ rows: [{ '?column?': 1 }] }]);
    const repository = new PgUserIdentityRepository(database.service);

    await expect(repository.isSessionActive('session-1')).resolves.toBe(true);
    const sql = database.queries[0].text;
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain('expires_at > now()');
    expect(database.queries[0].params).toEqual(['session-1']);
  });

  it('returns false for a revoked or missing session', async () => {
    const database = createTransactionalDatabase([{ rows: [] }]);
    const repository = new PgUserIdentityRepository(database.service);

    await expect(repository.isSessionActive('session-dead')).resolves.toBe(false);
  });
});

interface RecordedQuery {
  text: string;
  params: unknown[];
}

function createTransactionalDatabase(results: Array<{ rows: unknown[] }>) {
  const queries: RecordedQuery[] = [];
  let resultIndex = 0;

  const query = async (text: string, params: unknown[] = []) => {
    queries.push({ text, params });
    const result = results[resultIndex] ?? { rows: [] };
    if (resultIndex < results.length) {
      resultIndex += 1;
    }
    return result;
  };

  const service = {
    query,
    async transaction<T>(callback: (tx: { query: typeof query }) => Promise<T>): Promise<T> {
      return callback({ query });
    },
  } as unknown as DatabaseService;

  return { service, queries };
}

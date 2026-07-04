import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { PgUserIdentityRepository, type IdentityActor } from './pg-user-identity-repository';

const ACTOR: IdentityActor = {
  userId: '42',
  username: 'manager',
  roleId: 10,
  requestId: 'req-1',
};

describe('PgUserIdentityRepository.deleteLinkWithAudit', () => {
  it('writes one auth.identity.unlinked audit row PER deleted identity in one transaction', async () => {
    const database = createTransactionalDatabase([
      {
        rows: [
          { identity_id: '1', provider_user_id: 'sub-a', email_at_link: 'a@example.com' },
          { identity_id: '2', provider_user_id: 'sub-b', email_at_link: 'b@example.com' },
        ],
      },
    ]);
    const repository = new PgUserIdentityRepository(database.service);

    await expect(
      repository.deleteLinkWithAudit({ actor: ACTOR, provider: 'workos' }),
    ).resolves.toBe(true);

    const auditInserts = database.queries.filter((query) =>
      query.text.includes('auth.identity.unlinked'),
    );
    expect(auditInserts).toHaveLength(2);
    expect(JSON.stringify(auditInserts[0].params)).toContain('sub-a');
    expect(JSON.stringify(auditInserts[1].params)).toContain('sub-b');
  });

  it('returns false and writes no audit when nothing was linked', async () => {
    const database = createTransactionalDatabase([{ rows: [] }]);
    const repository = new PgUserIdentityRepository(database.service);

    await expect(
      repository.deleteLinkWithAudit({ actor: ACTOR, provider: 'workos' }),
    ).resolves.toBe(false);
    expect(database.queries.filter((query) => query.text.includes('audit_log'))).toHaveLength(0);
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

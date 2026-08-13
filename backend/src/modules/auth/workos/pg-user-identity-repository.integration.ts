import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { AuthSchemaCapabilities } from '../auth.module';
import {
  PgUserIdentityRepository,
  type IdentityActor,
} from './pg-user-identity-repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

const WORKOS_PROVIDER = 'workos';
const CAPS: AuthSchemaCapabilities = {
  loginPolicy: true,
  providerSessions: true,
  userIdentities: true,
  authMethod: true,
  workosUserControls: true,
};

type LoginPolicy = 'local' | 'external' | 'both';

type IdentitySeed = {
  providerUserId: string;
  emailAtLink: string;
  authMethod: string;
};

type SeededIdentity = IdentitySeed & {
  identityId: number;
};

type Fixture = {
  runId: string;
  userId: number;
  sessionId: string;
  username: string;
  requestIds: string[];
  providerUserIds: string[];
  identityIds: number[];
  identities: SeededIdentity[];
};

type IdentityRow = {
  identity_id: string | number;
  provider_user_id: string;
};

function makeDatabase(pool: Pool): DatabaseService {
  const database: Pick<DatabaseService, 'isConfigured' | 'query' | 'transaction'> = {
    isConfigured: true,
    query: (text: string, params: readonly unknown[] = []) => pool.query(text, [...params]),
    async transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();

      try {
        await client.query('BEGIN');
        const tx: TransactionClient = {
          raw: client,
          query: (text: string, params: readonly unknown[] = []) => client.query(text, [...params]),
        };
        const result = await handler(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };

  return database as DatabaseService;
}

function makeRequestId(fixture: Fixture, suffix: string): string {
  const requestId = `workos-ml-${fixture.runId}-${suffix}`;
  fixture.requestIds.push(requestId);
  return requestId;
}

function rememberProviderUserId(fixture: Fixture, providerUserId: string): void {
  if (!fixture.providerUserIds.includes(providerUserId)) {
    fixture.providerUserIds.push(providerUserId);
  }
}

function actorFor(fixture: Fixture, requestId: string): IdentityActor {
  return {
    userId: String(fixture.userId),
    username: fixture.username,
    roleId: 10,
    requestId,
    userAgent: 'vitest-workos-multilink',
    ipAddress: '127.0.0.1',
  };
}

describeIntegration('PgUserIdentityRepository.deleteOneLinkWithAudit (real PostgreSQL concurrency)', () => {
  let pool: Pool;
  let repository: PgUserIdentityRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
    repository = new PgUserIdentityRepository(makeDatabase(pool), CAPS);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('double-unlink same identity: one unlinked, one not_found, one audit row', async () => {
    const fixture = await seedFixture(pool, {
      loginPolicy: 'both',
      identities: [
        {
          providerUserId: `sub-double-${randomUUID()}`,
          emailAtLink: `double-${randomUUID()}@example.test`,
          authMethod: 'GoogleOAuth',
        },
      ],
    });

    try {
      const targetIdentity = fixture.identities[0];
      const [outcomeA, outcomeB] = await Promise.all([
        repository.deleteOneLinkWithAudit({
          identityId: String(targetIdentity.identityId),
          targetUserId: String(fixture.userId),
          actor: actorFor(fixture, makeRequestId(fixture, 'double-a')),
          actorSessionId: fixture.sessionId,
          provider: WORKOS_PROVIDER,
          mode: 'self_serve',
        }),
        repository.deleteOneLinkWithAudit({
          identityId: String(targetIdentity.identityId),
          targetUserId: String(fixture.userId),
          actor: actorFor(fixture, makeRequestId(fixture, 'double-b')),
          actorSessionId: fixture.sessionId,
          provider: WORKOS_PROVIDER,
          mode: 'self_serve',
        }),
      ]);

      expect([outcomeA, outcomeB].sort()).toEqual(['not_found', 'unlinked']);
      expect(await countLinks(pool, fixture.userId)).toBe(0);
      expect(await countUnlinkedAuditsForIdentity(pool, fixture.requestIds, String(targetIdentity.identityId))).toBe(1);
    } finally {
      await cleanupFixture(pool, fixture);
    }
  });

  it('unlink-vs-relink same target: old link gone, new sub present, count stays consistent', async () => {
    const fixture = await seedFixture(pool, {
      loginPolicy: 'both',
      identities: [
        {
          providerUserId: `sub-unlink-${randomUUID()}`,
          emailAtLink: `unlink-${randomUUID()}@example.test`,
          authMethod: 'GoogleOAuth',
        },
      ],
    });

    const newProviderUserId = `sub-relink-${randomUUID()}`;
    rememberProviderUserId(fixture, newProviderUserId);

    try {
      const oldIdentity = fixture.identities[0];
      const [unlinkOutcome, linkOutcome] = await Promise.all([
        repository.deleteOneLinkWithAudit({
          identityId: String(oldIdentity.identityId),
          targetUserId: String(fixture.userId),
          actor: actorFor(fixture, makeRequestId(fixture, 'unlink')),
          actorSessionId: fixture.sessionId,
          provider: WORKOS_PROVIDER,
          mode: 'self_serve',
        }),
        repository.insertLinkWithAudit({
          actor: actorFor(fixture, makeRequestId(fixture, 'relink')),
          provider: WORKOS_PROVIDER,
          providerUserId: newProviderUserId,
          emailAtLink: `relink-${randomUUID()}@example.test`,
          emailVerified: true,
          mode: 'self_serve',
          sessionId: fixture.sessionId,
          authMethod: 'Password',
        }),
      ]);

      expect(unlinkOutcome).toBe('unlinked');
      expect(linkOutcome.status).toBe('linked');

      if (linkOutcome.status === 'linked') {
        fixture.identityIds.push(Number(linkOutcome.record.identityId));
      }

      expect(await repository.findByProviderSub(WORKOS_PROVIDER, oldIdentity.providerUserId)).toBeNull();

      const relinked = await repository.findByProviderSub(WORKOS_PROVIDER, newProviderUserId);
      expect(relinked).toMatchObject({
        userId: String(fixture.userId),
        provider: WORKOS_PROVIDER,
        providerUserId: newProviderUserId,
      });

      const rows = await listIdentities(pool, fixture.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0].provider_user_id).toBe(newProviderUserId);
      expect(await countLinks(pool, fixture.userId)).toBe(1);
    } finally {
      await cleanupFixture(pool, fixture);
    }
  });

  it('last-link external under race: two deletes cannot bypass the lock and leave zero links', async () => {
    const fixture = await seedFixture(pool, {
      loginPolicy: 'external',
      identities: [
        {
          providerUserId: `sub-last-a-${randomUUID()}`,
          emailAtLink: `last-a-${randomUUID()}@example.test`,
          authMethod: 'GoogleOAuth',
        },
        {
          providerUserId: `sub-last-b-${randomUUID()}`,
          emailAtLink: `last-b-${randomUUID()}@example.test`,
          authMethod: 'Password',
        },
      ],
    });

    try {
      const [identityA, identityB] = fixture.identities;
      const outcomes = await Promise.all([
        repository.deleteOneLinkWithAudit({
          identityId: String(identityA.identityId),
          targetUserId: String(fixture.userId),
          actor: actorFor(fixture, makeRequestId(fixture, 'last-a')),
          actorSessionId: fixture.sessionId,
          provider: WORKOS_PROVIDER,
          mode: 'self_serve',
        }),
        repository.deleteOneLinkWithAudit({
          identityId: String(identityB.identityId),
          targetUserId: String(fixture.userId),
          actor: actorFor(fixture, makeRequestId(fixture, 'last-b')),
          actorSessionId: fixture.sessionId,
          provider: WORKOS_PROVIDER,
          mode: 'self_serve',
        }),
      ]);

      const remainingCount = await countLinks(pool, fixture.userId);
      const unlinkedCount = outcomes.filter((outcome) => outcome === 'unlinked').length;
      const externalPolicyCount = outcomes.filter((outcome) => outcome === 'external_policy').length;

      expect(outcomes).not.toContain('not_found');
      expect(unlinkedCount).toBeLessThanOrEqual(1);
      expect(externalPolicyCount).toBeGreaterThanOrEqual(1);
      expect(remainingCount).toBeGreaterThanOrEqual(1);
      expect(await countUnlinkedAudits(pool, fixture.requestIds)).toBe(unlinkedCount);
    } finally {
      await cleanupFixture(pool, fixture);
    }
  });
});

async function seedFixture(
  pool: Pool,
  options: { loginPolicy: LoginPolicy; identities: IdentitySeed[] },
): Promise<Fixture> {
  const runId = randomUUID();
  const username = `E2E-Тест-ml-${runId}`;
  const email = `e2e-ml-${runId}@example.test`;

  const userRow = await pool.query<{ user_id: string | number }>(
    `
    INSERT INTO users (username, email, password_hash, role_id, is_active, login_policy)
    VALUES ($1, $2, $3, $4, true, $5)
    RETURNING user_id
    `,
    [username, email, 'e2e-password-hash', 10, options.loginPolicy],
  );
  const userId = Number(userRow.rows[0].user_id);

  const sessionRow = await pool.query<{ session_id: string }>(
    `
    INSERT INTO auth_sessions (user_id, status, expires_at)
    VALUES ($1, 'active', now() + interval '1 day')
    RETURNING session_id
    `,
    [userId],
  );

  const fixture: Fixture = {
    runId,
    userId,
    sessionId: sessionRow.rows[0].session_id,
    username,
    requestIds: [],
    providerUserIds: [],
    identityIds: [],
    identities: [],
  };

  for (const identity of options.identities) {
    const identityRow = await pool.query<{ identity_id: string | number }>(
      `
      INSERT INTO user_identities (
        user_id, provider, provider_user_id, email_at_link, email_verified_at_link, auth_method
      )
      VALUES ($1, $2, $3, $4, true, $5)
      RETURNING identity_id
      `,
      [userId, WORKOS_PROVIDER, identity.providerUserId, identity.emailAtLink, identity.authMethod],
    );

    const seededIdentity: SeededIdentity = {
      ...identity,
      identityId: Number(identityRow.rows[0].identity_id),
    };

    fixture.providerUserIds.push(identity.providerUserId);
    fixture.identityIds.push(seededIdentity.identityId);
    fixture.identities.push(seededIdentity);
  }

  return fixture;
}

async function cleanupFixture(pool: Pool, fixture: Fixture): Promise<void> {
  const currentIdentityIds = fixture.providerUserIds.length
    ? await pool.query<{ identity_id: string | number }>(
        `
        SELECT identity_id
        FROM user_identities
        WHERE provider = $1 AND provider_user_id = ANY($2::text[])
        `,
        [WORKOS_PROVIDER, fixture.providerUserIds],
      )
    : { rows: [] };

  const identityIds = Array.from(
    new Set([
      ...fixture.identityIds,
      ...currentIdentityIds.rows.map((row) => Number(row.identity_id)),
    ]),
  );

  if (fixture.requestIds.length > 0) {
    await pool.query(`DELETE FROM audit_log WHERE request_id = ANY($1::text[])`, [fixture.requestIds]);
  }

  if (identityIds.length > 0) {
    await pool.query(`DELETE FROM user_identities WHERE identity_id = ANY($1::bigint[])`, [identityIds]);
  }

  await pool.query(`DELETE FROM auth_sessions WHERE session_id = $1`, [fixture.sessionId]);
  await pool.query(`DELETE FROM users WHERE user_id = $1`, [fixture.userId]);
}

async function countLinks(pool: Pool, userId: number): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM user_identities WHERE user_id = $1 AND provider = $2`,
    [userId, WORKOS_PROVIDER],
  );

  return Number(result.rows[0]?.count ?? '0');
}

async function listIdentities(pool: Pool, userId: number): Promise<IdentityRow[]> {
  const result = await pool.query<IdentityRow>(
    `
    SELECT identity_id, provider_user_id
    FROM user_identities
    WHERE user_id = $1 AND provider = $2
    ORDER BY identity_id
    `,
    [userId, WORKOS_PROVIDER],
  );

  return result.rows;
}

async function countUnlinkedAudits(pool: Pool, requestIds: string[]): Promise<number> {
  if (requestIds.length === 0) {
    return 0;
  }

  const result = await pool.query<{ count: string }>(
    `
    SELECT count(*)::text AS count
    FROM audit_log
    WHERE event = 'auth.identity.unlinked' AND request_id = ANY($1::text[])
    `,
    [requestIds],
  );

  return Number(result.rows[0]?.count ?? '0');
}

async function countUnlinkedAuditsForIdentity(
  pool: Pool,
  requestIds: string[],
  identityId: string,
): Promise<number> {
  if (requestIds.length === 0) {
    return 0;
  }

  const result = await pool.query<{ count: string }>(
    `
    SELECT count(*)::text AS count
    FROM audit_log
    WHERE event = 'auth.identity.unlinked'
      AND request_id = ANY($1::text[])
      AND metadata_json ->> 'identityId' = $2
    `,
    [requestIds, identityId],
  );

  return Number(result.rows[0]?.count ?? '0');
}

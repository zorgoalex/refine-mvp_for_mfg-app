import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { PgUserIdentityRepository, type IdentityActor } from './pg-user-identity-repository';

const CAPS_ON = {
  loginPolicy: true,
  providerSessions: true,
  userIdentities: true,
  authMethod: true,
  workosUserControls: true,
};
const CAPS_PRE055 = { ...CAPS_ON, authMethod: false };

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
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    const outcome = await repository.insertLinkWithAudit(input);

    expect(outcome.status).toBe('linked');
    // Snapshot EXISTS guards are NOT enough under READ COMMITTED — the
    // liveness proofs must be lock-based in the same transaction.
    expect(database.queries[0].text).toContain("status = 'active'");
    expect(database.queries[0].text).toContain('expires_at > now()');
    expect(database.queries[0].text).toContain('FOR UPDATE');
    expect(database.queries[1].text).toContain('is_active');
    expect(database.queries[1].text).toContain('is_service_account = false');
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
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

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
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    await expect(repository.insertLinkWithAudit(input)).resolves.toEqual({
      status: 'user_inactive',
    });
    expect(database.queries.filter((query) => query.text.includes('INSERT INTO user_identities'))).toHaveLength(0);
  });

  it('denies self-service linking when the target user toggle is off under lock', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] },
      {
        rows: [{
          login_policy: 'both',
          workos_self_link_enabled: false,
          workos_self_unlink_enabled: true,
        }],
      },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    await expect(repository.insertLinkWithAudit(input)).resolves.toEqual({
      status: 'self_link_disabled',
    });
    expect(
      database.queries.filter((query) => query.text.includes('INSERT INTO user_identities')),
    ).toHaveLength(0);
  });

  it('resolves a concurrent conflict deterministically: same user → already_linked, other user → conflict', async () => {
    const sameUser = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] }, // session lock
      { rows: [{ '?column?': 1 }] }, // user lock
      { rows: [] }, // conflicting insert
      { rows: [{ identity_id: '1', user_id: '42', provider: 'workos', provider_user_id: 'sub-a', email_at_link: 'a@example.com' }] },
    ]);
    await expect(
      new PgUserIdentityRepository(sameUser.service, CAPS_ON).insertLinkWithAudit(input),
    ).resolves.toMatchObject({ status: 'already_linked' });

    const otherUser = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] },
      { rows: [{ '?column?': 1 }] },
      { rows: [] },
      { rows: [{ identity_id: '1', user_id: '99', provider: 'workos', provider_user_id: 'sub-a', email_at_link: 'a@example.com' }] },
    ]);
    await expect(
      new PgUserIdentityRepository(otherUser.service, CAPS_ON).insertLinkWithAudit(input),
    ).resolves.toEqual({ status: 'conflict', conflictUserId: '99' });
  });

  it('retries the insert when the conflicting identity vanished between statements (concurrent unlink)', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] }, // session lock
      { rows: [{ login_policy: 'both' }] }, // user lock
      { rows: [] }, // insert lost to a conflicting row...
      { rows: [] }, // ...which was unlinked before classification
      { rows: [{ identity_id: '2', user_id: '42', provider: 'workos', provider_user_id: 'sub-a', email_at_link: 'a@example.com' }] }, // retry succeeds
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    await expect(repository.insertLinkWithAudit(input)).resolves.toMatchObject({ status: 'linked' });
    expect(
      database.queries.filter((query) => query.text.includes('INSERT INTO user_identities')),
    ).toHaveLength(2);
    expect(database.queries.filter((query) => query.text.includes('auth.identity.linked'))).toHaveLength(1);
  });

  it('skips the session lock for admin_bulk provisioning without a session', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] }, // user lock only
      { rows: [{ identity_id: '1', user_id: '42', provider: 'workos', provider_user_id: 'sub-a', email_at_link: 'a@example.com' }] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    await expect(
      repository.insertLinkWithAudit({ ...input, sessionId: undefined, mode: 'admin_bulk' }),
    ).resolves.toMatchObject({ status: 'linked' });
    expect(database.queries[0].text).not.toContain('auth_sessions');
    expect(database.queries[0].text).toContain('is_active');
    expect(database.queries[0].text).toContain('is_service_account = false');
  });
});

describe('PgUserIdentityRepository.insertLinkWithAudit auth_method', () => {
  it('writes auth_method into the identity row and linked audit', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] }, // session lock
      { rows: [{ login_policy: 'both' }] }, // user lock
      { rows: [{ identity_id: '1', user_id: '42', provider: 'workos', provider_user_id: 'sub-a', email_at_link: 'a@example.com' }] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    await repository.insertLinkWithAudit({
      actor: ACTOR, provider: 'workos', providerUserId: 'sub-a',
      emailAtLink: 'a@example.com', emailVerified: true, mode: 'self_serve',
      sessionId: 'session-1', authMethod: 'GoogleOAuth',
    });

    const insert = database.queries.find((q) => q.text.includes('INSERT INTO user_identities'));
    expect(insert?.text).toContain('auth_method');
    expect(JSON.stringify(insert?.params)).toContain('GoogleOAuth');
    const linkedAudit = database.queries.find((q) => q.text.includes('auth.identity.linked'));
    expect(JSON.parse(String(linkedAudit?.params[linkedAudit.params.length - 1]))).toMatchObject({ authMethod: 'GoogleOAuth' });
  });

  it('pre-055: insert omits the auth_method column entirely', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] }, { rows: [{ login_policy: 'both' }] },
      { rows: [{ identity_id: '1', user_id: '42', provider: 'workos', provider_user_id: 'sub-a', email_at_link: 'a@example.com' }] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_PRE055);
    await repository.insertLinkWithAudit({
      actor: ACTOR, provider: 'workos', providerUserId: 'sub-a',
      emailAtLink: 'a@example.com', emailVerified: true, mode: 'self_serve',
      sessionId: 'session-1', authMethod: 'GoogleOAuth',
    });
    const insert = database.queries.find((q) => q.text.includes('INSERT INTO user_identities'));
    expect(insert?.text).not.toContain('auth_method');
  });
});

describe('PgUserIdentityRepository.listLinks', () => {
  it('returns the provider identities of a user ordered by linked_at', async () => {
    const database = createTransactionalDatabase([
      { rows: [
        { identity_id: '1', auth_method: 'GoogleOAuth', email_at_link: 'a@company.com', linked_at: '2026-07-01T00:00:00Z', last_login_at: '2026-07-04T00:00:00Z' },
        { identity_id: '2', auth_method: null, email_at_link: 'a@gmail.com', linked_at: '2026-07-02T00:00:00Z', last_login_at: null },
      ] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    await expect(repository.listLinks('42', 'workos')).resolves.toEqual([
      { identityId: '1', authMethod: 'GoogleOAuth', emailAtLink: 'a@company.com', linkedAt: '2026-07-01T00:00:00Z', lastLoginAt: '2026-07-04T00:00:00Z' },
      { identityId: '2', authMethod: null, emailAtLink: 'a@gmail.com', linkedAt: '2026-07-02T00:00:00Z', lastLoginAt: null },
    ]);
    expect(database.queries[0].text).toContain('WHERE user_id = $1 AND provider = $2');
    expect(database.queries[0].text).toContain('ORDER BY linked_at');
  });

  it('pre-055: omits auth_method from the SELECT and returns authMethod null (R3-MAJOR)', async () => {
    const database = createTransactionalDatabase([
      { rows: [
        { identity_id: '1', email_at_link: 'a@company.com', linked_at: '2026-07-01T00:00:00Z', last_login_at: null },
      ] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_PRE055);
    await expect(repository.listLinks('42', 'workos')).resolves.toEqual([
      { identityId: '1', authMethod: null, emailAtLink: 'a@company.com', linkedAt: '2026-07-01T00:00:00Z', lastLoginAt: null },
    ]);
    expect(database.queries[0].text).not.toContain('auth_method');
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
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

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
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

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
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

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
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    await expect(
      repository.deleteLinkWithAudit({ actor: ACTOR, provider: 'workos', sessionId: 'session-1' }),
    ).resolves.toBe('not_linked');
    expect(database.queries.filter((query) => query.text.includes('audit_log'))).toHaveLength(0);
  });
});

describe('PgUserIdentityRepository.deleteOneLinkWithAudit', () => {
  const base = { identityId: '1', targetUserId: '42', actor: ACTOR, provider: 'workos', mode: 'self_serve' as const, actorSessionId: 'session-1' };

  it('deletes a single identity of the target and writes one unlinked audit', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] },
      { rows: [{ login_policy: 'both', is_active: true }] },
      { rows: [{ identity_id: '1', provider_user_id: 'sub-a', email_at_link: 'a@example.com', auth_method: 'GoogleOAuth' }] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    await expect(repository.deleteOneLinkWithAudit(base)).resolves.toBe('unlinked');
    const del = database.queries.find((q) => q.text.includes('DELETE FROM user_identities'));
    expect(del?.text).toContain('identity_id = $1');
    expect(del?.text).toContain('user_id = $2');
    const audit = database.queries.find((q) => q.text.includes('auth.identity.unlinked'));
    expect(audit?.text).toContain('related_user_id');
    expect(audit?.params[4]).toBe(42);
  });

  it('denies self-service unlink when its independent toggle is off', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] },
      {
        rows: [{
          login_policy: 'both',
          is_active: true,
          workos_self_unlink_enabled: false,
        }],
      },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    await expect(repository.deleteOneLinkWithAudit(base)).resolves.toBe(
      'self_unlink_disabled',
    );
    expect(
      database.queries.filter((query) => query.text.includes('DELETE FROM user_identities')),
    ).toHaveLength(0);
  });

  it('returns not_found when the identity is not the target user’s (no audit)', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] },
      { rows: [{ login_policy: 'both', is_active: true }] },
      { rows: [] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);
    await expect(repository.deleteOneLinkWithAudit(base)).resolves.toBe('not_found');
    expect(database.queries.filter((q) => q.text.includes('DELETE FROM user_identities'))).toHaveLength(0);
    expect(database.queries.filter((q) => q.text.includes('audit_log'))).toHaveLength(0);
  });

  it('refuses to remove the LAST link of an external-only user (409), NO delete, NO audit', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] },
      { rows: [{ login_policy: 'external', is_active: true }] },
      { rows: [{ identity_id: '1', provider_user_id: 'sub-a', email_at_link: 'a@example.com', auth_method: null }] },
      { rows: [{ count: '1' }] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);
    await expect(repository.deleteOneLinkWithAudit(base)).resolves.toBe('external_policy');
    expect(database.queries.filter((q) => q.text.includes('DELETE FROM user_identities'))).toHaveLength(0);
    expect(database.queries.filter((q) => q.text.includes('auth.identity.unlinked'))).toHaveLength(0);
  });

  it('allows an admin to remove the last external-only identity and revokes target sessions', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] },
      { rows: [{ login_policy: 'external', is_active: true }] },
      { rows: [{ identity_id: '1', provider_user_id: 'sub-a', email_at_link: 'a@example.com', auth_method: null }] },
      { rows: [] },
      { rows: [{ session_id: '02bed022-f183-487b-8e2f-4603665a2add' }] },
      { rows: [] },
      { rows: [] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    await expect(repository.deleteOneLinkWithAudit({
      ...base,
      mode: 'admin',
      actorSessionId: 'admin-session',
      actor: { userId: '7', username: 'admin', roleId: 1 },
    })).resolves.toBe('unlinked');
    expect(database.queries.some((query) => query.text.includes('count(*)'))).toBe(false);
    expect(database.queries.some((query) => query.text.includes('DELETE FROM user_identities'))).toBe(true);
    expect(database.queries.some((query) => query.text.includes('UPDATE auth_sessions'))).toBe(true);
    expect(database.queries.some((query) => query.text.includes('auth.identity.unlinked'))).toBe(true);
  });

  it('returns not_found (404-priority) BEFORE the external-guard for a wrong identity', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] },
      { rows: [{ login_policy: 'external', is_active: true }] },
      { rows: [] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);
    await expect(repository.deleteOneLinkWithAudit(base)).resolves.toBe('not_found');
    expect(database.queries.some((q) => q.text.includes('SELECT count(*)'))).toBe(false);
  });

  it('allows admin to unlink from a DEACTIVATED target (is_active ignored on admin path)', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] },
      { rows: [{ login_policy: 'both', is_active: false }] },
      { rows: [{ identity_id: '1', provider_user_id: 'sub-a', email_at_link: 'a@example.com', auth_method: 'GoogleOAuth' }] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);
    await expect(repository.deleteOneLinkWithAudit({
      ...base, mode: 'admin', actorSessionId: 'admin-session',
      actor: { userId: '7', username: 'admin', roleId: 1 },
    })).resolves.toBe('unlinked');
    expect(database.queries[0].text).toContain('FROM auth_sessions');
    expect(database.queries[0].params).toEqual(['admin-session']);
  });

  it('denies with session_inactive when the ACTOR (admin) session is revoked — no delete, no audit', async () => {
    const database = createTransactionalDatabase([
      { rows: [] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);
    await expect(repository.deleteOneLinkWithAudit({
      ...base, mode: 'admin', actorSessionId: 'revoked-admin',
      actor: { userId: '7', username: 'admin', roleId: 1 },
    })).resolves.toBe('session_inactive');
    expect(database.queries.filter((q) => q.text.includes('DELETE FROM user_identities'))).toHaveLength(0);
    expect(database.queries.filter((q) => q.text.includes('auth.identity.unlinked'))).toHaveLength(0);
  });

  it('pre-055 node: no auth_method in SELECT/INSERT, still unlinks', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] },
      { rows: [{ login_policy: 'both', is_active: true }] },
      { rows: [{ identity_id: '1', provider_user_id: 'sub-a', email_at_link: 'a@example.com' }] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_PRE055);
    await expect(repository.deleteOneLinkWithAudit(base)).resolves.toBe('unlinked');
    const lookup = database.queries.find((q) => q.text.includes('FROM user_identities WHERE identity_id'));
    expect(lookup?.text).not.toContain('auth_method');
    const audit = database.queries.find((q) => q.text.includes('auth.identity.unlinked'));
    expect(JSON.parse(String(audit?.params[audit.params.length - 1]))).toMatchObject({ authMethod: null });
  });

  it('writes an admin audit with actor≠target and reason (ACTOR session STILL re-proven)', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] },
      { rows: [{ login_policy: 'both', is_active: true }] },
      { rows: [{ identity_id: '1', provider_user_id: 'sub-a', email_at_link: 'a@example.com', auth_method: 'Password' }] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);
    await repository.deleteOneLinkWithAudit({
      ...base, mode: 'admin', reason: 'уволен', actorSessionId: 'admin-session',
      actor: { userId: '7', username: 'admin', roleId: 1 },
    });
    expect(database.queries[0].text).toContain('FROM auth_sessions');
    expect(database.queries[0].params).toEqual(['admin-session']);
    const audit = database.queries.find((q) => q.text.includes('auth.identity.unlinked'));
    expect(audit?.params[0]).toBe('42');
    expect(audit?.params[1]).toBe(7);
    expect(audit?.params[2]).toBe('admin');
    expect(audit?.params[4]).toBe(42);
    const meta = JSON.parse(String(audit?.params[audit.params.length - 1]));
    expect(meta).toMatchObject({ mode: 'admin', reason: 'уволен', identityId: '1' });
  });

  it('revokes all target sessions and refresh tokens on administrator unlink', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] },
      { rows: [{ login_policy: 'both', is_active: true }] },
      {
        rows: [{
          identity_id: '1',
          provider_user_id: 'sub-a',
          email_at_link: 'a@example.com',
          auth_method: 'GoogleOAuth',
        }],
      },
      { rows: [] },
      { rows: [{ session_id: '02bed022-f183-487b-8e2f-4603665a2add' }] },
      { rows: [] },
      { rows: [] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    await repository.deleteOneLinkWithAudit({
      ...base,
      mode: 'admin',
      actorSessionId: 'admin-session',
      actor: { userId: '7', username: 'admin', roleId: 1 },
    });

    expect(
      database.queries.find((query) => query.text.includes('UPDATE auth_sessions'))?.text,
    ).toContain("status = 'revoked'");
    expect(
      database.queries.find((query) => query.text.includes('UPDATE refresh_tokens'))?.params,
    ).toEqual([
      ['02bed022-f183-487b-8e2f-4603665a2add'],
      'sso_identity_admin_unlinked',
    ]);
    const audit = database.queries.find((query) =>
      query.text.includes('auth.identity.unlinked'),
    );
    expect(JSON.parse(String(audit?.params[audit.params.length - 1]))).toMatchObject({
      revokedSessions: 1,
    });
  });
});

describe('PgUserIdentityRepository.writeLinkFailed', () => {
  it('writes the affected user into related_user_id (query-ready, plan §4.8)', async () => {
    const database = createTransactionalDatabase([{ rows: [] }]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

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

describe('PgUserIdentityRepository administrator controls', () => {
  it('refuses external-only policy without an allowed SSO identity', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] },
      {
        rows: [{
          login_policy: 'both',
          workos_self_link_enabled: true,
          workos_self_unlink_enabled: true,
        }],
      },
      { rows: [{ count: '0' }] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    await expect(
      repository.updateUserSettingsWithAudit({
        actor: { userId: '7', username: 'admin', roleId: 1 },
        actorSessionId: 'admin-session',
        targetUserId: '42',
        settings: { loginPolicy: 'external' },
      }),
    ).resolves.toEqual({ status: 'external_requires_identity' });
    expect(
      database.queries.filter((query) => query.text.includes('UPDATE users')),
    ).toHaveLength(0);
  });

  it('revokes an active invitation with the actor session and audit in one transaction', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] },
      { rows: [{ '?column?': 1 }] },
      { rows: [{ invitation_id: '02bed022-f183-487b-8e2f-4603665a2add' }] },
      { rows: [] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    await expect(repository.revokeActiveLinkInvitationsWithAudit({
      actor: { userId: '7', username: 'admin', roleId: 1, requestId: 'req-revoke' },
      actorSessionId: 'admin-session',
      targetUserId: '42',
    })).resolves.toEqual({ status: 'revoked', revoked: true });
    expect(database.queries[0].text).toContain("status = 'active'");
    expect(database.queries[1].text).toContain('FOR UPDATE');
    expect(database.queries[2].text).toContain('SET revoked_at = now()');
    expect(database.queries[2].text).toContain('expires_at > now()');
    const audit = database.queries[3];
    expect(audit.text).toContain('auth.identity.invitation_revoked');
    expect(audit.params.join(' ')).not.toContain('token');
    expect(JSON.parse(String(audit.params[audit.params.length - 1]))).toEqual({
      mode: 'admin',
      revokedInvitations: 1,
    });
  });

  it('returns revoked=false without an audit when there is no live invitation', async () => {
    const database = createTransactionalDatabase([
      { rows: [{ '?column?': 1 }] },
      { rows: [{ '?column?': 1 }] },
      { rows: [] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    await expect(repository.revokeActiveLinkInvitationsWithAudit({
      actor: { userId: '7', username: 'admin', roleId: 1 },
      actorSessionId: 'admin-session',
      targetUserId: '42',
    })).resolves.toEqual({ status: 'revoked', revoked: false });
    expect(database.queries.some((query) => query.text.includes('audit_log'))).toBe(false);
  });

  it('atomically consumes an invitation and links the exact provider sub', async () => {
    const database = createTransactionalDatabase([
      {
        rows: [{
          target_user_id: '42',
          created_by_user_id: '7',
          expires_at: '2099-07-26T20:00:00.000Z',
          consumed_at: null,
          revoked_at: null,
          is_active: true,
          actor_username: 'admin',
          actor_role_id: 1,
        }],
      },
      {
        rows: [{
          identity_id: '9',
          user_id: '42',
          provider: 'workos',
          provider_user_id: 'sub-approved',
          email_at_link: 'approved@example.com',
        }],
      },
      { rows: [] },
      { rows: [] },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    await expect(
      repository.consumeInvitationAndLinkWithAudit({
        invitationId: '02bed022-f183-487b-8e2f-4603665a2add',
        provider: 'workos',
        providerUserId: 'sub-approved',
        emailAtLink: 'approved@example.com',
        emailVerified: true,
        authMethod: 'GoogleOAuth',
      }),
    ).resolves.toEqual({ status: 'linked' });

    const identityInsert = database.queries.find((query) =>
      query.text.includes('INSERT INTO user_identities'),
    );
    expect(identityInsert?.params.slice(0, 4)).toEqual([
      '42',
      'workos',
      'sub-approved',
      'approved@example.com',
    ]);
    expect(
      database.queries.find((query) =>
        query.text.includes('SET consumed_at = now()'),
      )?.params,
    ).toEqual(['02bed022-f183-487b-8e2f-4603665a2add']);
    const audit = database.queries.find((query) =>
      query.text.includes('auth.identity.linked'),
    );
    expect(audit?.params[0]).toBe('42');
    expect(audit?.params[1]).toBe(7);
  });

  it('does not consume an invitation when the provider sub belongs to another user', async () => {
    const database = createTransactionalDatabase([
      {
        rows: [{
          target_user_id: '42',
          created_by_user_id: '7',
          expires_at: '2099-07-26T20:00:00.000Z',
          consumed_at: null,
          revoked_at: null,
          is_active: true,
          actor_username: 'admin',
          actor_role_id: 1,
        }],
      },
      { rows: [] },
      {
        rows: [{
          identity_id: '4',
          user_id: '99',
          provider: 'workos',
          provider_user_id: 'sub-conflict',
          email_at_link: 'other@example.com',
        }],
      },
    ]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    await expect(
      repository.consumeInvitationAndLinkWithAudit({
        invitationId: '02bed022-f183-487b-8e2f-4603665a2add',
        provider: 'workos',
        providerUserId: 'sub-conflict',
        emailAtLink: 'other@example.com',
        emailVerified: true,
      }),
    ).resolves.toEqual({ status: 'conflict', conflictUserId: '99' });
    expect(
      database.queries.some((query) => query.text.includes('SET consumed_at = now()')),
    ).toBe(false);
  });
});

describe('PgUserIdentityRepository.isSessionActive', () => {
  it('requires an active, unexpired auth_sessions row', async () => {
    const database = createTransactionalDatabase([{ rows: [{ '?column?': 1 }] }]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

    await expect(repository.isSessionActive('session-1')).resolves.toBe(true);
    const sql = database.queries[0].text;
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain('expires_at > now()');
    expect(database.queries[0].params).toEqual(['session-1']);
  });

  it('returns false for a revoked or missing session', async () => {
    const database = createTransactionalDatabase([{ rows: [] }]);
    const repository = new PgUserIdentityRepository(database.service, CAPS_ON);

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

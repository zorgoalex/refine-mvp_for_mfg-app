import type { QueryResultRow } from 'pg';
import { DatabaseService } from '../../../database/database.service';
import { mapRoleIdToRole } from '../../../permissions/permissions';
import type { AuthSchemaCapabilities } from '../auth.module';

const DEFAULT_REQUEST_ID = 'auth-command';

export interface UserIdentityRecord {
  identityId: string;
  userId: string;
  provider: string;
  providerUserId: string;
  emailAtLink: string;
}

export type IdentityLinkMode = 'self_serve' | 'admin_bulk';

export type IdentityLinkFailedReason =
  | 'state_mismatch'
  | 'identity_conflict'
  | 'email_not_verified'
  | 'provider_error'
  | 'session_inactive';

export type LinkInsertOutcome =
  | { status: 'linked'; record: UserIdentityRecord }
  | { status: 'already_linked'; record: UserIdentityRecord }
  | { status: 'conflict'; conflictUserId: string }
  | { status: 'session_inactive' }
  | { status: 'user_inactive' };

export type UserIdentityListItem = {
  identityId: string;
  authMethod: string | null;
  emailAtLink: string;
  linkedAt: string;
  lastLoginAt: string | null;
};

export type DeleteOneOutcome =
  | 'unlinked'
  | 'not_found'
  | 'session_inactive'
  | 'user_inactive'
  | 'external_policy';

export type UnlinkDeleteOutcome =
  | 'unlinked'
  | 'not_linked'
  | 'session_inactive'
  | 'user_inactive'
  | 'external_policy';

export interface IdentityActor {
  userId: string;
  username: string;
  roleId: number;
  requestId?: string;
  userAgent?: string;
  ipAddress?: string;
}

interface UserIdentityRow extends QueryResultRow {
  identity_id: string | number;
  user_id: string | number;
  provider: string;
  provider_user_id: string;
  email_at_link: string;
}

interface UserIdentityAuditRow extends QueryResultRow {
  identity_id: string | number;
  provider_user_id: string;
  email_at_link: string;
  auth_method?: string | null;
}

export class PgUserIdentityRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly caps: AuthSchemaCapabilities,
  ) {}

  async findByProviderSub(provider: string, providerUserId: string): Promise<UserIdentityRecord | null> {
    const result = await this.database.query<UserIdentityRow>(
      `
      SELECT identity_id, user_id, provider, provider_user_id, email_at_link
      FROM user_identities
      WHERE provider = $1 AND provider_user_id = $2
      LIMIT 1
      `,
      [provider, providerUserId],
    );

    return toRecord(result.rows[0]);
  }

  async findByUserId(userId: string, provider: string): Promise<UserIdentityRecord | null> {
    const result = await this.database.query<UserIdentityRow>(
      `
      SELECT identity_id, user_id, provider, provider_user_id, email_at_link
      FROM user_identities
      WHERE user_id = $1 AND provider = $2
      LIMIT 1
      `,
      [userId, provider],
    );

    return toRecord(result.rows[0]);
  }

  async listLinks(userId: string, provider: string): Promise<UserIdentityListItem[]> {
    const result = await this.database.query<{
      identity_id: string | number;
      auth_method?: string | null;
      email_at_link: string;
      linked_at: string;
      last_login_at: string | null;
    } & QueryResultRow>(
      `SELECT identity_id, email_at_link, linked_at, last_login_at${this.caps.authMethod ? ', auth_method' : ''}
       FROM user_identities WHERE user_id = $1 AND provider = $2 ORDER BY linked_at`,
      [userId, provider],
    );

    return result.rows.map((row) => ({
      identityId: String(row.identity_id),
      authMethod: row.auth_method ?? null,
      emailAtLink: row.email_at_link,
      linkedAt: String(row.linked_at),
      lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
    }));
  }

  /**
   * Inserts the identity link and its audit event in one transaction.
   *
   * The transaction is the authority (service-level pre-checks are only a
   * fast-fail UX): the session and user rows are LOCKED (FOR UPDATE) before
   * the insert, so a concurrent logout/deactivate either commits first (and
   * the locked re-read sees it) or blocks until this link commits — plain
   * snapshot EXISTS guards are not enough under READ COMMITTED. ON CONFLICT
   * keeps a concurrent same-sub callback deterministic instead of a raw
   * 23505.
   */
  async insertLinkWithAudit(input: {
    actor: IdentityActor;
    provider: string;
    providerUserId: string;
    emailAtLink: string;
    emailVerified: boolean;
    mode: IdentityLinkMode;
    /** Required for self_serve; admin_bulk provisioning has no live session. */
    sessionId?: string;
    authMethod?: string | null;
  }): Promise<LinkInsertOutcome> {
    return this.database.transaction(async (tx) => {
      const liveness = await this.lockLiveSessionAndUser(tx, input.actor.userId, input.sessionId);

      if (liveness.deny) {
        return liveness.deny;
      }

      // insert → classify is two statements; under READ COMMITTED the
      // conflicting identity can be unlinked between them, leaving zero rows
      // in both. Retry the insert in that (rare) case instead of failing —
      // the freed sub is simply claimable again.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const insertColumns = this.caps.authMethod
          ? '(user_id, provider, provider_user_id, email_at_link, email_verified_at_link, auth_method)'
          : '(user_id, provider, provider_user_id, email_at_link, email_verified_at_link)';
        const insertValues = this.caps.authMethod
          ? '($1, $2, $3, $4, $5, $6)'
          : '($1, $2, $3, $4, $5)';
        const params = this.caps.authMethod
          ? [
              input.actor.userId,
              input.provider,
              input.providerUserId,
              input.emailAtLink,
              input.emailVerified,
              input.authMethod ?? null,
            ]
          : [
              input.actor.userId,
              input.provider,
              input.providerUserId,
              input.emailAtLink,
              input.emailVerified,
            ];
        const inserted = await tx.query<UserIdentityRow>(
          `
          INSERT INTO user_identities ${insertColumns}
          VALUES ${insertValues}
          ON CONFLICT (provider, provider_user_id) DO NOTHING
          RETURNING identity_id, user_id, provider, provider_user_id, email_at_link
          `,
          params,
        );
        const record = toRecord(inserted.rows[0]);

        if (record) {
          await this.writeLinkedAudit(tx, input);
          return { status: 'linked', record };
        }

        const conflict = await this.classifyConflict(tx, input);

        if (conflict) {
          return conflict;
        }
        // Conflict row vanished (concurrent unlink) — retry the insert.
      }

      throw new Error('user_identities insert kept racing a concurrent unlink');
    });
  }

  private async writeLinkedAudit(
    tx: { query: DatabaseService['query'] },
    input: {
      actor: IdentityActor;
      provider: string;
      providerUserId: string;
      emailAtLink: string;
      emailVerified: boolean;
      mode: IdentityLinkMode;
      authMethod?: string | null;
    },
  ): Promise<void> {
    await tx.query(
      `
      INSERT INTO audit_log (
        event, entity_type, entity_id, user_id, username, role_code, role,
        related_user_id, request_id, ip_address, user_agent, source, metadata_json
      )
      VALUES ('auth.identity.linked', 'user', $1, $2, $3, $4, $4, $5, $6, $7::inet, $8, 'workos', $9::jsonb)
      `,
      [
        input.actor.userId,
        toNullableUserId(input.actor.userId),
        input.actor.username,
        mapRoleIdToRole(input.actor.roleId),
        toNullableUserId(input.actor.userId),
        input.actor.requestId ?? DEFAULT_REQUEST_ID,
        input.actor.ipAddress ?? null,
        input.actor.userAgent ?? null,
        JSON.stringify({
          provider: input.provider,
          workosSub: input.providerUserId,
          emailAtLink: input.emailAtLink,
          authMethod: input.authMethod ?? null,
          emailVerified: input.emailVerified,
          mode: input.mode,
        }),
      ],
    );
  }

  /**
   * Locks the session (when given) and user rows FOR UPDATE and verifies
   * liveness under the lock. A concurrent logout/deactivate either committed
   * first (the locked re-read fails the WHERE) or waits for this tx.
   * Returns a deny outcome, or null when both proofs hold.
   */
  private async lockLiveSessionAndUser(
    tx: { query: DatabaseService['query'] },
    userId: string,
    sessionId?: string,
  ): Promise<
    | { deny: Extract<LinkInsertOutcome, { status: 'session_inactive' | 'user_inactive' }>; loginPolicy: null }
    | { deny: null; loginPolicy: string | null }
  > {
    if (sessionId) {
      const session = await tx.query(
        `
        SELECT 1 FROM auth_sessions
        WHERE session_id = $1 AND status = 'active' AND expires_at > now()
        FOR UPDATE
        `,
        [sessionId],
      );

      if (session.rows.length === 0) {
        return { deny: { status: 'session_inactive' }, loginPolicy: null };
      }
    }

    const user = await tx.query<{ login_policy: string | null } & QueryResultRow>(
      'SELECT login_policy FROM users WHERE user_id = $1 AND is_active FOR UPDATE',
      [userId],
    );
    const row = user.rows[0];

    if (!row) {
      return { deny: { status: 'user_inactive' }, loginPolicy: null };
    }

    return { deny: null, loginPolicy: row.login_policy ?? null };
  }

  /**
   * Zero-row conflict insert (liveness already proven under lock). Returns
   * null when the conflicting row vanished between the statements — the
   * caller retries the insert.
   */
  private async classifyConflict(
    tx: { query: DatabaseService['query'] },
    input: { actor: IdentityActor; provider: string; providerUserId: string },
  ): Promise<LinkInsertOutcome | null> {
    const existing = await tx.query<UserIdentityRow>(
      `
      SELECT identity_id, user_id, provider, provider_user_id, email_at_link
      FROM user_identities
      WHERE provider = $1 AND provider_user_id = $2
      LIMIT 1
      `,
      [input.provider, input.providerUserId],
    );
    const record = toRecord(existing.rows[0]);

    if (record) {
      return record.userId === input.actor.userId
        ? { status: 'already_linked', record }
        : { status: 'conflict', conflictUserId: record.userId };
    }

    return null;
  }

  /**
   * Removes ALL identity links of the provider for the user and writes one
   * audit event PER removed identity in the same transaction (the plan
   * explicitly supports several provider subs per user). The session and
   * user rows are locked and re-verified in the SAME transaction as the
   * delete — a session revoked after the service pre-check cannot unlink.
   */
  async deleteLinkWithAudit(input: {
    actor: IdentityActor;
    provider: string;
    /** Live-session proof re-checked under lock in the delete transaction. */
    sessionId?: string;
  }): Promise<UnlinkDeleteOutcome> {
    return this.database.transaction(async (tx) => {
      const liveness = await this.lockLiveSessionAndUser(tx, input.actor.userId, input.sessionId);

      if (liveness.deny) {
        return liveness.deny.status;
      }

      // Policy re-check UNDER the user lock: an ops flip to external-only
      // during bcrypt must not let the user delete their last SSO identity
      // and lock themselves out.
      if (liveness.loginPolicy === 'external') {
        return 'external_policy';
      }

      const deleted = await tx.query<UserIdentityRow>(
        `
        DELETE FROM user_identities
        WHERE user_id = $1 AND provider = $2
        RETURNING identity_id, provider_user_id, email_at_link
        `,
        [input.actor.userId, input.provider],
      );

      if (deleted.rows.length === 0) {
        return 'not_linked';
      }

      for (const row of deleted.rows) {
        await tx.query(
          `
          INSERT INTO audit_log (
            event, entity_type, entity_id, user_id, username, role_code, role,
            related_user_id, request_id, ip_address, user_agent, source, metadata_json
          )
          VALUES ('auth.identity.unlinked', 'user', $1, $2, $3, $4, $4, $5, $6, $7::inet, $8, 'workos', $9::jsonb)
          `,
          [
            input.actor.userId,
            toNullableUserId(input.actor.userId),
            input.actor.username,
            mapRoleIdToRole(input.actor.roleId),
            toNullableUserId(input.actor.userId),
            input.actor.requestId ?? DEFAULT_REQUEST_ID,
            input.actor.ipAddress ?? null,
            input.actor.userAgent ?? null,
            JSON.stringify({
              provider: input.provider,
              workosSub: row.provider_user_id,
              emailAtLink: row.email_at_link,
            }),
          ],
        );
      }

      return 'unlinked';
    });
  }

  async deleteOneLinkWithAudit(input: {
    identityId: string;
    targetUserId: string;
    actor: IdentityActor;
    actorSessionId: string;
    provider: string;
    mode: 'self_serve' | 'admin';
    reason?: string;
  }): Promise<DeleteOneOutcome> {
    return this.database.transaction(async (tx) => {
      const session = await tx.query(
        `SELECT 1 FROM auth_sessions WHERE session_id = $1 AND status = 'active' AND expires_at > now() FOR UPDATE`,
        [input.actorSessionId],
      );
      if (session.rows.length === 0) {
        return 'session_inactive';
      }

      const user = await tx.query<{ login_policy: string | null; is_active: boolean } & QueryResultRow>(
        `SELECT login_policy, is_active FROM users WHERE user_id = $1 FOR UPDATE`,
        [input.targetUserId],
      );
      const urow = user.rows[0];
      if (!urow) {
        return 'not_found';
      }
      if (input.mode === 'self_serve' && !urow.is_active) {
        return 'user_inactive';
      }

      const found = await tx.query<UserIdentityAuditRow>(
        `SELECT identity_id, provider_user_id, email_at_link${this.caps.authMethod ? ', auth_method' : ''} FROM user_identities WHERE identity_id = $1 AND user_id = $2 AND provider = $3`,
        [input.identityId, input.targetUserId, input.provider],
      );
      const row = found.rows[0];
      if (!row) {
        return 'not_found';
      }

      if ((urow.login_policy ?? 'both') === 'external') {
        const remaining = await tx.query<{ count: string } & QueryResultRow>(
          `SELECT count(*)::text AS count FROM user_identities WHERE user_id = $1 AND provider = $2`,
          [input.targetUserId, input.provider],
        );
        if (Number(remaining.rows[0]?.count ?? '0') <= 1) {
          return 'external_policy';
        }
      }

      await tx.query(
        `DELETE FROM user_identities WHERE identity_id = $1 AND user_id = $2 AND provider = $3`,
        [input.identityId, input.targetUserId, input.provider],
      );
      await this.writeUnlinkedAudit(tx, {
        actor: input.actor,
        targetUserId: input.targetUserId,
        provider: input.provider,
        workosSub: row.provider_user_id,
        emailAtLink: row.email_at_link,
        authMethod: row.auth_method ?? null,
        mode: input.mode,
        identityId: input.identityId,
        reason: input.reason,
      });

      return 'unlinked';
    });
  }

  /** Live-session proof for link/unlink at callback time (plan §4.4в). */
  async isSessionActive(sessionId: string): Promise<boolean> {
    const result = await this.database.query(
      `
      SELECT 1
      FROM auth_sessions
      WHERE session_id = $1 AND status = 'active' AND expires_at > now()
      LIMIT 1
      `,
      [sessionId],
    );

    return result.rows.length > 0;
  }

  async writeLinkFailed(input: {
    actor: IdentityActor;
    reason: IdentityLinkFailedReason;
    provider: string;
    providerUserId?: string;
    emailAtIdentity?: string;
    conflictUserId?: string;
  }): Promise<void> {
    await this.database.query(
      `
      INSERT INTO audit_log (
        event, entity_type, entity_id, user_id, username, role_code, role,
        related_user_id, request_id, ip_address, user_agent, source, metadata_json
      )
      VALUES ('auth.identity.link_failed', 'user', $1, $2, $3, $4, $4, $5, $6, $7::inet, $8, 'workos', $9::jsonb)
      `,
      [
        input.actor.userId,
        toNullableUserId(input.actor.userId),
        input.actor.username,
        mapRoleIdToRole(input.actor.roleId),
        toNullableUserId(input.actor.userId),
        input.actor.requestId ?? DEFAULT_REQUEST_ID,
        input.actor.ipAddress ?? null,
        input.actor.userAgent ?? null,
        JSON.stringify({
          provider: input.provider,
          reason: input.reason,
          workosSub: input.providerUserId ?? null,
          emailAtIdentity: input.emailAtIdentity ?? null,
          conflictUserId: input.conflictUserId ?? null,
        }),
      ],
    );
  }

  private async writeUnlinkedAudit(
    tx: { query: DatabaseService['query'] },
    input: {
      actor: IdentityActor;
      targetUserId: string;
      provider: string;
      workosSub: string;
      emailAtLink: string;
      authMethod: string | null;
      mode: 'self_serve' | 'admin';
      identityId: string;
      reason?: string;
    },
  ): Promise<void> {
    await tx.query(
      `
      INSERT INTO audit_log (
        event, entity_type, entity_id, user_id, username, role_code, role,
        related_user_id, request_id, ip_address, user_agent, source, metadata_json
      )
      VALUES ('auth.identity.unlinked', 'user', $1, $2, $3, $4, $4, $5, $6, $7::inet, $8, 'workos', $9::jsonb)
      `,
      [
        input.targetUserId,
        toNullableUserId(input.actor.userId),
        input.actor.username,
        mapRoleIdToRole(input.actor.roleId),
        toNullableUserId(input.targetUserId),
        input.actor.requestId ?? DEFAULT_REQUEST_ID,
        input.actor.ipAddress ?? null,
        input.actor.userAgent ?? null,
        JSON.stringify({
          provider: input.provider,
          workosSub: input.workosSub,
          emailAtLink: input.emailAtLink,
          authMethod: input.authMethod,
          mode: input.mode,
          identityId: input.identityId,
          reason: input.reason ?? null,
        }),
      ],
    );
  }

  async touchLastLogin(identityId: string): Promise<void> {
    await this.database.query('UPDATE user_identities SET last_login_at = now() WHERE identity_id = $1', [
      identityId,
    ]);
  }
}

function toRecord(row: UserIdentityRow | undefined): UserIdentityRecord | null {
  if (!row) {
    return null;
  }

  return {
    identityId: String(row.identity_id),
    userId: String(row.user_id),
    provider: row.provider,
    providerUserId: row.provider_user_id,
    emailAtLink: row.email_at_link,
  };
}

function toNullableUserId(userId: string): number | null {
  const parsed = Number(userId);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

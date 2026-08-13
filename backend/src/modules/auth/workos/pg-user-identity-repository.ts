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

export type IdentityLinkMode = 'self_serve' | 'admin_bulk' | 'admin_invitation';

export type WorkosLoginPolicy = 'local' | 'external' | 'both';

export interface WorkosUserSettings {
  loginPolicy: WorkosLoginPolicy;
  selfLinkEnabled: boolean;
  selfUnlinkEnabled: boolean;
}

export interface WorkosLinkInvitation {
  invitationId: string;
  targetUserId: string;
  expiresAt: string;
}

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
  | { status: 'user_inactive' }
  | { status: 'self_link_disabled' };

export type InvitationLinkOutcome =
  | { status: 'linked' | 'already_linked' }
  | { status: 'conflict'; conflictUserId: string }
  | { status: 'invitation_invalid' }
  | { status: 'user_inactive' };

export type SettingsUpdateOutcome =
  | { status: 'updated'; settings: WorkosUserSettings }
  | { status: 'not_found' }
  | { status: 'session_inactive' }
  | { status: 'external_requires_identity' };

export type InvitationCreateOutcome =
  | { status: 'created'; invitation: WorkosLinkInvitation }
  | { status: 'not_found' }
  | { status: 'user_inactive' }
  | { status: 'session_inactive' };

export type InvitationRevokeOutcome =
  | { status: 'revoked'; revoked: boolean }
  | { status: 'not_found' }
  | { status: 'session_inactive' };

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
  | 'external_policy'
  | 'self_unlink_disabled';

export type UnlinkDeleteOutcome =
  | 'unlinked'
  | 'not_linked'
  | 'session_inactive'
  | 'user_inactive'
  | 'external_policy'
  | 'self_unlink_disabled';

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

  async getUserSettings(userId: string): Promise<WorkosUserSettings | null> {
    const result = await this.database.query<{
      login_policy: string | null;
      workos_self_link_enabled: boolean;
      workos_self_unlink_enabled: boolean;
    } & QueryResultRow>(
      `
      SELECT login_policy, workos_self_link_enabled, workos_self_unlink_enabled
      FROM users
      WHERE user_id = $1
      LIMIT 1
      `,
      [userId],
    );

    return toSettings(result.rows[0]);
  }

  async updateUserSettingsWithAudit(input: {
    actor: IdentityActor;
    actorSessionId: string;
    targetUserId: string;
    settings: Partial<WorkosUserSettings>;
  }): Promise<SettingsUpdateOutcome> {
    return this.database.transaction(async (tx) => {
      const session = await tx.query(
        `SELECT 1 FROM auth_sessions
         WHERE session_id = $1 AND status = 'active' AND expires_at > now()
         FOR UPDATE`,
        [input.actorSessionId],
      );
      if (session.rows.length === 0) {
        return { status: 'session_inactive' };
      }

      const current = await tx.query<{
        login_policy: string | null;
        workos_self_link_enabled: boolean;
        workos_self_unlink_enabled: boolean;
      } & QueryResultRow>(
        `
        SELECT login_policy, workos_self_link_enabled, workos_self_unlink_enabled
        FROM users
        WHERE user_id = $1
        FOR UPDATE
        `,
        [input.targetUserId],
      );
      const before = toSettings(current.rows[0]);

      if (!before) {
        return { status: 'not_found' };
      }

      const next: WorkosUserSettings = {
        loginPolicy: input.settings.loginPolicy ?? before.loginPolicy,
        selfLinkEnabled: input.settings.selfLinkEnabled ?? before.selfLinkEnabled,
        selfUnlinkEnabled: input.settings.selfUnlinkEnabled ?? before.selfUnlinkEnabled,
      };

      if (next.loginPolicy === 'external') {
        const links = await tx.query<{ count: string } & QueryResultRow>(
          `SELECT count(*)::text AS count
           FROM user_identities
           WHERE user_id = $1 AND provider = 'workos'`,
          [input.targetUserId],
        );
        if (Number(links.rows[0]?.count ?? '0') === 0) {
          return { status: 'external_requires_identity' };
        }
      }

      await tx.query(
        `
        UPDATE users
        SET login_policy = $2,
            workos_self_link_enabled = $3,
            workos_self_unlink_enabled = $4
        WHERE user_id = $1
        `,
        [
          input.targetUserId,
          next.loginPolicy,
          next.selfLinkEnabled,
          next.selfUnlinkEnabled,
        ],
      );

      let revokedSessions = 0;
      if (before.loginPolicy !== next.loginPolicy) {
        revokedSessions = await this.revokeTargetSessions(
          tx,
          input.targetUserId,
          `sso_policy_${next.loginPolicy}`,
        );
      }

      await tx.query(
        `
        INSERT INTO audit_log (
          event, entity_type, entity_id, user_id, username, role_code, role,
          related_user_id, request_id, ip_address, user_agent, source, metadata_json
        )
        VALUES (
          'auth.identity.settings_updated', 'user', $1, $2, $3, $4, $4,
          $5, $6, $7::inet, $8, 'workos', $9::jsonb
        )
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
          JSON.stringify({ before, after: next, revokedSessions, mode: 'admin' }),
        ],
      );

      return { status: 'updated', settings: next };
    });
  }

  async createLinkInvitationWithAudit(input: {
    invitationId: string;
    tokenHash: string;
    expiresAt: Date;
    targetUserId: string;
    actor: IdentityActor;
    actorSessionId: string;
  }): Promise<InvitationCreateOutcome> {
    return this.database.transaction(async (tx) => {
      const session = await tx.query(
        `SELECT 1 FROM auth_sessions
         WHERE session_id = $1 AND status = 'active' AND expires_at > now()
         FOR UPDATE`,
        [input.actorSessionId],
      );
      if (session.rows.length === 0) {
        return { status: 'session_inactive' };
      }

      const target = await tx.query<{ is_active: boolean } & QueryResultRow>(
        `SELECT is_active FROM users WHERE user_id = $1 FOR UPDATE`,
        [input.targetUserId],
      );
      const targetRow = target.rows[0];
      if (!targetRow) {
        return { status: 'not_found' };
      }
      if (!targetRow.is_active) {
        return { status: 'user_inactive' };
      }

      await tx.query(
        `
        UPDATE workos_link_invitations
        SET revoked_at = now()
        WHERE target_user_id = $1
          AND consumed_at IS NULL
          AND revoked_at IS NULL
        `,
        [input.targetUserId],
      );

      await tx.query(
        `
        INSERT INTO workos_link_invitations (
          invitation_id, target_user_id, created_by_user_id, token_hash, expires_at
        )
        VALUES ($1, $2, $3, $4, $5)
        `,
        [
          input.invitationId,
          input.targetUserId,
          input.actor.userId,
          input.tokenHash,
          input.expiresAt,
        ],
      );

      await tx.query(
        `
        INSERT INTO audit_log (
          event, entity_type, entity_id, user_id, username, role_code, role,
          related_user_id, request_id, ip_address, user_agent, source, metadata_json
        )
        VALUES (
          'auth.identity.invitation_created', 'user', $1, $2, $3, $4, $4,
          $5, $6, $7::inet, $8, 'workos', $9::jsonb
        )
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
            invitationId: input.invitationId,
            expiresAt: input.expiresAt.toISOString(),
            mode: 'admin',
          }),
        ],
      );

      return {
        status: 'created',
        invitation: {
          invitationId: input.invitationId,
          targetUserId: input.targetUserId,
          expiresAt: input.expiresAt.toISOString(),
        },
      };
    });
  }

  async revokeActiveLinkInvitationsWithAudit(input: {
    targetUserId: string;
    actor: IdentityActor;
    actorSessionId: string;
  }): Promise<InvitationRevokeOutcome> {
    return this.database.transaction(async (tx) => {
      const session = await tx.query(
        `SELECT 1 FROM auth_sessions
         WHERE session_id = $1 AND status = 'active' AND expires_at > now()
         FOR UPDATE`,
        [input.actorSessionId],
      );
      if (session.rows.length === 0) {
        return { status: 'session_inactive' };
      }

      const target = await tx.query(
        `SELECT 1 FROM users WHERE user_id = $1 FOR UPDATE`,
        [input.targetUserId],
      );
      if (target.rows.length === 0) {
        return { status: 'not_found' };
      }

      const revoked = await tx.query<{ invitation_id: string } & QueryResultRow>(
        `
        UPDATE workos_link_invitations
        SET revoked_at = now()
        WHERE target_user_id = $1
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > now()
        RETURNING invitation_id
        `,
        [input.targetUserId],
      );

      if (revoked.rows.length === 0) {
        return { status: 'revoked', revoked: false };
      }

      await tx.query(
        `
        INSERT INTO audit_log (
          event, entity_type, entity_id, user_id, username, role_code, role,
          related_user_id, request_id, ip_address, user_agent, source, metadata_json
        )
        VALUES (
          'auth.identity.invitation_revoked', 'user', $1, $2, $3, $4, $4,
          $5, $6, $7::inet, $8, 'workos', $9::jsonb
        )
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
          JSON.stringify({ mode: 'admin', revokedInvitations: revoked.rows.length }),
        ],
      );

      return { status: 'revoked', revoked: true };
    });
  }

  async findActiveInvitationByHash(tokenHash: string): Promise<WorkosLinkInvitation | null> {
    const result = await this.database.query<{
      invitation_id: string;
      target_user_id: string | number;
      expires_at: string;
    } & QueryResultRow>(
      `
      SELECT invitation_id, target_user_id, expires_at
      FROM workos_link_invitations
      WHERE token_hash = $1
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      LIMIT 1
      `,
      [tokenHash],
    );
    const row = result.rows[0];

    return row
      ? {
          invitationId: row.invitation_id,
          targetUserId: String(row.target_user_id),
          expiresAt: String(row.expires_at),
        }
      : null;
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
      if (input.mode === 'self_serve' && !liveness.settings.selfLinkEnabled) {
        return { status: 'self_link_disabled' };
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

  async consumeInvitationAndLinkWithAudit(input: {
    invitationId: string;
    provider: string;
    providerUserId: string;
    emailAtLink: string;
    emailVerified: boolean;
    authMethod?: string | null;
    requestId?: string;
    userAgent?: string;
    ipAddress?: string;
  }): Promise<InvitationLinkOutcome> {
    return this.database.transaction(async (tx) => {
      const invitation = await tx.query<{
        target_user_id: string | number;
        created_by_user_id: string | number;
        expires_at: string;
        consumed_at: string | null;
        revoked_at: string | null;
        is_active: boolean;
        actor_username: string;
        actor_role_id: string | number;
      } & QueryResultRow>(
        `
        SELECT
          invitation.target_user_id,
          invitation.created_by_user_id,
          invitation.expires_at,
          invitation.consumed_at,
          invitation.revoked_at,
          target.is_active,
          actor.username AS actor_username,
          actor.role_id AS actor_role_id
        FROM workos_link_invitations invitation
        JOIN users target ON target.user_id = invitation.target_user_id
        JOIN users actor ON actor.user_id = invitation.created_by_user_id
        WHERE invitation.invitation_id = $1
        FOR UPDATE OF invitation, target
        `,
        [input.invitationId],
      );
      const row = invitation.rows[0];

      if (
        !row ||
        row.consumed_at ||
        row.revoked_at ||
        new Date(row.expires_at).getTime() <= Date.now()
      ) {
        return { status: 'invitation_invalid' };
      }
      if (!row.is_active) {
        return { status: 'user_inactive' };
      }

      const targetUserId = String(row.target_user_id);
      const actor: IdentityActor = {
        userId: String(row.created_by_user_id),
        username: row.actor_username,
        roleId: Number(row.actor_role_id),
        requestId: input.requestId,
        userAgent: input.userAgent,
        ipAddress: input.ipAddress,
      };
      const insertColumns = this.caps.authMethod
        ? '(user_id, provider, provider_user_id, email_at_link, email_verified_at_link, auth_method)'
        : '(user_id, provider, provider_user_id, email_at_link, email_verified_at_link)';
      const insertValues = this.caps.authMethod
        ? '($1, $2, $3, $4, $5, $6)'
        : '($1, $2, $3, $4, $5)';
      const params = this.caps.authMethod
        ? [
            targetUserId,
            input.provider,
            input.providerUserId,
            input.emailAtLink,
            input.emailVerified,
            input.authMethod ?? null,
          ]
        : [
            targetUserId,
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

      let status: 'linked' | 'already_linked' = 'linked';
      if (inserted.rows.length === 0) {
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
        if (!record || record.userId !== targetUserId) {
          return {
            status: 'conflict',
            conflictUserId: record?.userId ?? 'unknown',
          };
        }
        status = 'already_linked';
      }

      await tx.query(
        `UPDATE workos_link_invitations SET consumed_at = now() WHERE invitation_id = $1`,
        [input.invitationId],
      );

      if (status === 'linked') {
        await this.writeLinkedAudit(tx, {
          actor,
          targetUserId,
          provider: input.provider,
          providerUserId: input.providerUserId,
          emailAtLink: input.emailAtLink,
          emailVerified: input.emailVerified,
          authMethod: input.authMethod,
          mode: 'admin_invitation',
          invitationId: input.invitationId,
        });
      }

      return { status };
    });
  }

  private async writeLinkedAudit(
    tx: { query: DatabaseService['query'] },
    input: {
      actor: IdentityActor;
      targetUserId?: string;
      provider: string;
      providerUserId: string;
      emailAtLink: string;
      emailVerified: boolean;
      mode: IdentityLinkMode;
      authMethod?: string | null;
      invitationId?: string;
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
        input.targetUserId ?? input.actor.userId,
        toNullableUserId(input.actor.userId),
        input.actor.username,
        mapRoleIdToRole(input.actor.roleId),
        toNullableUserId(input.targetUserId ?? input.actor.userId),
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
          invitationId: input.invitationId ?? null,
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
    | {
        deny: Extract<LinkInsertOutcome, { status: 'session_inactive' | 'user_inactive' }>;
        settings: WorkosUserSettings;
      }
    | { deny: null; settings: WorkosUserSettings }
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
        return { deny: { status: 'session_inactive' }, settings: DEFAULT_WORKOS_USER_SETTINGS };
      }
    }

    const user = await tx.query<{
      login_policy: string | null;
      workos_self_link_enabled: boolean;
      workos_self_unlink_enabled: boolean;
    } & QueryResultRow>(
      `
      SELECT login_policy, workos_self_link_enabled, workos_self_unlink_enabled
      FROM users
      WHERE user_id = $1 AND is_active
      FOR UPDATE
      `,
      [userId],
    );
    const row = user.rows[0];

    if (!row) {
      return { deny: { status: 'user_inactive' }, settings: DEFAULT_WORKOS_USER_SETTINGS };
    }

    return { deny: null, settings: toSettings(row) ?? DEFAULT_WORKOS_USER_SETTINGS };
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
      if (!liveness.settings.selfUnlinkEnabled) {
        return 'self_unlink_disabled';
      }
      if (liveness.settings.loginPolicy === 'external') {
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

      const user = await tx.query<{
        login_policy: string | null;
        is_active: boolean;
        workos_self_unlink_enabled: boolean;
      } & QueryResultRow>(
        `
        SELECT login_policy, is_active, workos_self_unlink_enabled
        FROM users
        WHERE user_id = $1
        FOR UPDATE
        `,
        [input.targetUserId],
      );
      const urow = user.rows[0];
      if (!urow) {
        return 'not_found';
      }
      if (input.mode === 'self_serve' && !urow.is_active) {
        return 'user_inactive';
      }
      if (input.mode === 'self_serve' && urow.workos_self_unlink_enabled === false) {
        return 'self_unlink_disabled';
      }

      const found = await tx.query<UserIdentityAuditRow>(
        `SELECT identity_id, provider_user_id, email_at_link${this.caps.authMethod ? ', auth_method' : ''} FROM user_identities WHERE identity_id = $1 AND user_id = $2 AND provider = $3`,
        [input.identityId, input.targetUserId, input.provider],
      );
      const row = found.rows[0];
      if (!row) {
        return 'not_found';
      }

      if (input.mode === 'self_serve' && (urow.login_policy ?? 'both') === 'external') {
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
      const revokedSessions =
        input.mode === 'admin'
          ? await this.revokeTargetSessions(tx, input.targetUserId, 'sso_identity_admin_unlinked')
          : 0;
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
        revokedSessions,
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
      revokedSessions?: number;
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
          revokedSessions: input.revokedSessions ?? 0,
        }),
      ],
    );
  }

  private async revokeTargetSessions(
    tx: { query: DatabaseService['query'] },
    targetUserId: string,
    reason: string,
  ): Promise<number> {
    const revoked = await tx.query<{ session_id: string } & QueryResultRow>(
      `
      UPDATE auth_sessions
      SET status = 'revoked', revoked_at = now()
      WHERE user_id = $1 AND status = 'active'
      RETURNING session_id
      `,
      [targetUserId],
    );

    if (revoked.rows.length > 0) {
      await tx.query(
        `
        UPDATE refresh_tokens
        SET revoked_at = COALESCE(revoked_at, now()),
            revoked_reason = COALESCE(revoked_reason, $2)
        WHERE session_id = ANY($1::uuid[])
          AND revoked_at IS NULL
        `,
        [revoked.rows.map((row) => row.session_id), reason],
      );
    }

    return revoked.rows.length;
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

const DEFAULT_WORKOS_USER_SETTINGS: WorkosUserSettings = {
  loginPolicy: 'both',
  selfLinkEnabled: true,
  selfUnlinkEnabled: true,
};

function toSettings(
  row:
    | {
        login_policy: string | null;
        workos_self_link_enabled: boolean;
        workos_self_unlink_enabled: boolean;
      }
    | undefined,
): WorkosUserSettings | null {
  if (!row) {
    return null;
  }

  return {
    loginPolicy:
      row.login_policy === 'local' || row.login_policy === 'external'
        ? row.login_policy
        : 'both',
    selfLinkEnabled: row.workos_self_link_enabled !== false,
    selfUnlinkEnabled: row.workos_self_unlink_enabled !== false,
  };
}

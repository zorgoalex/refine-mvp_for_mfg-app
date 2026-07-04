import type { QueryResultRow } from 'pg';
import { DatabaseService } from '../../../database/database.service';
import { mapRoleIdToRole } from '../../../permissions/permissions';

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

export class PgUserIdentityRepository {
  constructor(private readonly database: DatabaseService) {}

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

  /** Inserts the identity link and its audit event in one transaction. */
  async insertLinkWithAudit(input: {
    actor: IdentityActor;
    provider: string;
    providerUserId: string;
    emailAtLink: string;
    emailVerified: boolean;
    mode: IdentityLinkMode;
  }): Promise<UserIdentityRecord> {
    return this.database.transaction(async (tx) => {
      const inserted = await tx.query<UserIdentityRow>(
        `
        INSERT INTO user_identities (user_id, provider, provider_user_id, email_at_link, email_verified_at_link)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING identity_id, user_id, provider, provider_user_id, email_at_link
        `,
        [input.actor.userId, input.provider, input.providerUserId, input.emailAtLink, input.emailVerified],
      );

      await tx.query(
        `
        INSERT INTO audit_log (
          event, entity_type, entity_id, user_id, username, role_code, role,
          request_id, ip_address, user_agent, source, metadata_json
        )
        VALUES ('auth.identity.linked', 'user', $1, $2, $3, $4, $4, $5, $6::inet, $7, 'workos', $8::jsonb)
        `,
        [
          input.actor.userId,
          toNullableUserId(input.actor.userId),
          input.actor.username,
          mapRoleIdToRole(input.actor.roleId),
          input.actor.requestId ?? DEFAULT_REQUEST_ID,
          input.actor.ipAddress ?? null,
          input.actor.userAgent ?? null,
          JSON.stringify({
            provider: input.provider,
            workosSub: input.providerUserId,
            emailAtLink: input.emailAtLink,
            emailVerified: input.emailVerified,
            mode: input.mode,
          }),
        ],
      );

      const record = toRecord(inserted.rows[0]);

      if (!record) {
        throw new Error('user_identities insert returned no row');
      }

      return record;
    });
  }

  /**
   * Removes ALL identity links of the provider for the user and writes one
   * audit event PER removed identity in the same transaction (the plan
   * explicitly supports several provider subs per user).
   */
  async deleteLinkWithAudit(input: { actor: IdentityActor; provider: string }): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const deleted = await tx.query<UserIdentityRow>(
        `
        DELETE FROM user_identities
        WHERE user_id = $1 AND provider = $2
        RETURNING identity_id, provider_user_id, email_at_link
        `,
        [input.actor.userId, input.provider],
      );

      if (deleted.rows.length === 0) {
        return false;
      }

      for (const row of deleted.rows) {
        await tx.query(
          `
          INSERT INTO audit_log (
            event, entity_type, entity_id, user_id, username, role_code, role,
            request_id, ip_address, user_agent, source, metadata_json
          )
          VALUES ('auth.identity.unlinked', 'user', $1, $2, $3, $4, $4, $5, $6::inet, $7, 'workos', $8::jsonb)
          `,
          [
            input.actor.userId,
            toNullableUserId(input.actor.userId),
            input.actor.username,
            mapRoleIdToRole(input.actor.roleId),
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

      return true;
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
        request_id, ip_address, user_agent, source, metadata_json
      )
      VALUES ('auth.identity.link_failed', 'user', $1, $2, $3, $4, $4, $5, $6::inet, $7, 'workos', $8::jsonb)
      `,
      [
        input.actor.userId,
        toNullableUserId(input.actor.userId),
        input.actor.username,
        mapRoleIdToRole(input.actor.roleId),
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

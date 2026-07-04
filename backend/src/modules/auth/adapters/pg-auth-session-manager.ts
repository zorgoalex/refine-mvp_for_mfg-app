import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole, mapRoleIdToRole } from '../../../permissions/permissions';
import { UserInactiveError } from '../auth.errors';
import type {
  AuthResponse,
  AuthSessionRecord,
  AuthUserRecord,
  IssuedAccessToken,
  LoginCommand,
  LoginResult,
  LoginSessionContext,
  SessionManagerPort,
} from '../auth.types';
import type { AuthSessionHttpPort, LogoutCommand, LogoutResult, RefreshCommand } from '../http/auth-session-http.port';
import { TokenService } from '../token.service';
import { JwtAccessTokenIssuer } from './jwt-access-token-issuer';

interface CreatedSessionRow extends QueryResultRow {
  session_id: string;
  token_family_id: string;
}

interface CreatedTokenRow extends QueryResultRow {
  token_id: string;
}

interface RefreshSessionRow extends QueryResultRow {
  token_id: string;
  user_id: string | number;
  session_id: string;
  token_family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  session_status: string;
  username: string;
  role_id: string | number;
  is_active: boolean;
}

interface AuthAuditInput {
  event: 'auth.login.success' | 'auth.logout' | 'auth.refresh' | 'auth.refresh.reuse_detected';
  userId: string | number;
  username: string;
  roleId: string | number;
  sessionId: string;
  tokenFamilyId: string;
  requestId?: string;
  userAgent?: string;
  ipAddress?: string;
  /** First-class audit_log.source column value; 'backend' when absent. */
  authSource?: 'backend' | 'workos';
  metadata?: Record<string, unknown>;
}

const DEFAULT_REQUEST_ID = 'auth-command';

export interface PgAuthSessionManagerOptions {
  refreshTokenPepper: string;
  refreshTokenTtlDays: number;
  /**
   * auth_sessions.provider_session_id exists only after migration 052; the
   * column is written/read only when the WorkOS flag is enabled so the
   * backend stays deployable against a pre-052 database.
   */
  supportsProviderSessions?: boolean;
}

export class PgAuthSessionManager implements SessionManagerPort, AuthSessionHttpPort {
  constructor(
    private readonly database: DatabaseService,
    private readonly tokenService: TokenService,
    private readonly accessTokens: JwtAccessTokenIssuer,
    private readonly options: PgAuthSessionManagerOptions,
  ) {}

  async createLoginSession(user: AuthUserRecord, context: LoginSessionContext): Promise<AuthSessionRecord> {
    const refreshToken = this.tokenService.generateRefreshToken();
    const tokenHash = this.hashRefreshToken(refreshToken);
    const expiresAt = this.refreshTokenExpiresAt();
    return this.database.transaction(async (tx) => {
      // With the WorkOS flag on (migration 052 columns exist), the auth
      // source is ALWAYS persisted — an SSO session whose provider returned
      // no usable sid must stay distinguishable at logout ('unavailable',
      // not 'not_applicable'). Pre-052 databases keep the legacy insert.
      const session = this.options.supportsProviderSessions
        ? await tx.query<CreatedSessionRow>(
            `
            INSERT INTO auth_sessions (user_id, expires_at, ip_address, user_agent, provider_session_id, auth_source)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING session_id::text, token_family_id::text
            `,
            [
              user.id,
              expiresAt,
              context.ipAddress ?? null,
              context.userAgent ?? null,
              context.providerSessionId ?? null,
              context.authSource ?? 'backend',
            ],
          )
        : await tx.query<CreatedSessionRow>(
            `
            INSERT INTO auth_sessions (user_id, expires_at, ip_address, user_agent)
            VALUES ($1, $2, $3, $4)
            RETURNING session_id::text, token_family_id::text
            `,
            [user.id, expiresAt, context.ipAddress ?? null, context.userAgent ?? null],
          );
      const sessionRow = session.rows[0];

      await tx.query(
        `
        INSERT INTO refresh_tokens (
          user_id,
          session_id,
          token_hash,
          token_family_id,
          expires_at,
          user_agent,
          ip_address
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          user.id,
          sessionRow.session_id,
          tokenHash,
          sessionRow.token_family_id,
          expiresAt,
          context.userAgent ?? null,
          context.ipAddress ?? null,
        ],
      );

      await tx.query('UPDATE users SET last_login_at = now() WHERE user_id = $1', [user.id]);
      await this.writeAudit(tx, {
        event: 'auth.login.success',
        userId: user.id,
        username: user.username,
        roleId: user.roleId,
        sessionId: sessionRow.session_id,
        tokenFamilyId: sessionRow.token_family_id,
        requestId: context.requestId,
        userAgent: context.userAgent,
        ipAddress: context.ipAddress,
        authSource: context.authSource,
        metadata: {
          outcome: 'success',
          ...context.auditMetadata,
        },
      });

      return {
        sessionId: sessionRow.session_id,
        userId: user.id,
        refreshToken,
        refreshTokenExpiresAt: expiresAt,
      };
    });
  }

  async refresh(command: RefreshCommand): Promise<LoginResult> {
    const tokenHash = this.hashRefreshToken(command.refreshToken);

    return this.database.transaction(async (tx) => {
      const current = await this.lockRefreshToken(tx, tokenHash);

      if (!current) {
        throw new ApiError(401, 'REFRESH_TOKEN_INVALID', 'Refresh token is invalid');
      }

      if (current.revoked_at) {
        await this.markReuseDetected(tx, current, command);
        throw new ApiError(
          401,
          'REFRESH_TOKEN_REUSE_DETECTED',
          'Refresh token reuse detected',
        );
      }

      if (current.expires_at.getTime() <= Date.now()) {
        await this.expireSession(tx, current);
        throw new ApiError(401, 'REFRESH_TOKEN_EXPIRED', 'Refresh token expired');
      }

      if (current.session_status !== 'active') {
        throw new ApiError(401, 'REFRESH_TOKEN_INVALID', 'Refresh session is not active');
      }

      if (!current.is_active) {
        await this.revokeTokenFamily(tx, current, 'user_inactive');
        throw new UserInactiveError();
      }

      const newRefreshToken = this.tokenService.generateRefreshToken();
      const newTokenHash = this.hashRefreshToken(newRefreshToken);
      const newRefreshTokenExpiresAt = this.refreshTokenExpiresAt();

      await tx.query(
        `
        UPDATE refresh_tokens
        SET revoked_at = now(), revoked_reason = 'rotated'
        WHERE token_id = $1
        `,
        [current.token_id],
      );
      const inserted = await tx.query<CreatedTokenRow>(
        `
        INSERT INTO refresh_tokens (
          user_id,
          session_id,
          token_hash,
          token_family_id,
          expires_at,
          user_agent,
          ip_address
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING token_id::text
        `,
        [
          current.user_id,
          current.session_id,
          newTokenHash,
          current.token_family_id,
          newRefreshTokenExpiresAt,
          command.userAgent ?? null,
          command.ipAddress ?? null,
        ],
      );
      await tx.query(
        `
        UPDATE refresh_tokens
        SET replaced_by_token_id = $2
        WHERE token_id = $1
        `,
        [current.token_id, inserted.rows[0].token_id],
      );
      await tx.query(
        `
        UPDATE auth_sessions
        SET last_seen_at = now()
        WHERE session_id = $1
        `,
        [current.session_id],
      );
      await this.writeAudit(tx, {
        event: 'auth.refresh',
        userId: current.user_id,
        username: current.username,
        roleId: current.role_id,
        sessionId: current.session_id,
        tokenFamilyId: current.token_family_id,
        requestId: command.requestId,
        userAgent: command.userAgent,
        ipAddress: command.ipAddress,
        metadata: {
          outcome: 'success',
          rotated: true,
        },
      });

      const currentUser = this.toCurrentUser(current, current.session_id);
      const issuedAccessToken = await this.accessTokens.issueAccessToken(currentUser);

      return {
        response: this.toAuthResponse(currentUser, issuedAccessToken),
        refreshToken: newRefreshToken,
        refreshTokenExpiresAt: newRefreshTokenExpiresAt,
      };
    });
  }

  async logout(command: LogoutCommand): Promise<LogoutResult> {
    if (!command.refreshToken) {
      if (command.currentUser?.sessionId) {
        const currentUser = {
          ...command.currentUser,
          sessionId: command.currentUser.sessionId,
        };
        return this.database.transaction(async (tx) => {
          const providerSession = await this.readProviderSession(tx, currentUser.sessionId);
          await tx.query(
            `
            UPDATE auth_sessions
            SET status = 'revoked', revoked_at = now(), revoke_reason = 'logout'
            WHERE session_id = $1 AND status = 'active'
            `,
            [currentUser.sessionId],
          );
          await this.writeCurrentUserLogoutAudit(tx, { ...command, currentUser });
          return { ok: true as const, ...providerSession };
        });
      }
      return { ok: true };
    }

    const tokenHash = this.hashRefreshToken(command.refreshToken);

    return this.database.transaction(async (tx) => {
      const current = await this.lockRefreshToken(tx, tokenHash);

      if (!current) {
        return { ok: true as const };
      }

      const providerSession = await this.readProviderSession(tx, current.session_id);
      await this.revokeTokenFamily(tx, current, 'logout');
      await this.writeAudit(tx, {
        event: 'auth.logout',
        userId: current.user_id,
        username: current.username,
        roleId: current.role_id,
        sessionId: current.session_id,
        tokenFamilyId: current.token_family_id,
        requestId: command.requestId,
        userAgent: command.userAgent,
        ipAddress: command.ipAddress,
        metadata: {
          reason: 'logout',
          refreshTokenPresent: true,
        },
      });
      return { ok: true as const, ...providerSession };
    });
  }

  private async readProviderSession(
    tx: TransactionClient,
    sessionId: string,
  ): Promise<{ providerSessionId?: string; authSource?: string }> {
    if (!this.options.supportsProviderSessions) {
      return {};
    }

    const result = await tx.query<
      { provider_session_id: string | null; auth_source: string | null } & QueryResultRow
    >('SELECT provider_session_id, auth_source FROM auth_sessions WHERE session_id = $1', [sessionId]);
    // Normalize at the read boundary: legacy/dirty whitespace-only values
    // must degrade to "no provider session", not leak into a logout redirect
    // with a garbage session_id.
    const raw = result.rows[0]?.provider_session_id;
    const normalized = typeof raw === 'string' ? raw.trim() : null;
    const authSource = result.rows[0]?.auth_source ?? undefined;

    return {
      ...(normalized ? { providerSessionId: normalized } : {}),
      ...(authSource ? { authSource } : {}),
    };
  }

  private async lockRefreshToken(
    tx: TransactionClient,
    tokenHash: string,
  ): Promise<RefreshSessionRow | null> {
    const result = await tx.query<RefreshSessionRow>(
      `
      SELECT
        rt.token_id::text,
        rt.user_id,
        rt.session_id::text,
        rt.token_family_id::text,
        rt.expires_at,
        rt.revoked_at,
        s.status AS session_status,
        u.username,
        u.role_id,
        u.is_active
      FROM refresh_tokens rt
      JOIN auth_sessions s ON s.session_id = rt.session_id
      JOIN users u ON u.user_id = rt.user_id
      WHERE rt.token_hash = $1
      FOR UPDATE OF rt, s
      `,
      [tokenHash],
    );

    return result.rows[0] ?? null;
  }

  private async markReuseDetected(
    tx: TransactionClient,
    current: RefreshSessionRow,
    context?: Pick<RefreshCommand, 'requestId' | 'userAgent' | 'ipAddress'>,
  ): Promise<void> {
    await tx.query(
      `
      UPDATE refresh_tokens
      SET reuse_detected_at = COALESCE(reuse_detected_at, now()),
          revoked_reason = COALESCE(revoked_reason, 'reuse_detected')
      WHERE token_id = $1
      `,
      [current.token_id],
    );
    await this.revokeTokenFamily(tx, current, 'reuse_detected');
    await tx.query(
      `
      UPDATE auth_sessions
      SET status = 'reuse_detected', revoked_at = now(), revoke_reason = 'reuse_detected'
      WHERE session_id = $1
      `,
      [current.session_id],
    );
    await this.writeAudit(tx, {
      event: 'auth.refresh.reuse_detected',
      userId: current.user_id,
      username: current.username,
      roleId: current.role_id,
      sessionId: current.session_id,
      tokenFamilyId: current.token_family_id,
      requestId: context?.requestId,
      userAgent: context?.userAgent,
      ipAddress: context?.ipAddress,
      metadata: {
        outcome: 'rejected',
        reason: 'reuse_detected',
      },
    });
  }

  private async expireSession(tx: TransactionClient, current: RefreshSessionRow): Promise<void> {
    await tx.query(
      `
      UPDATE refresh_tokens
      SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = 'expired'
      WHERE token_id = $1
      `,
      [current.token_id],
    );
    await tx.query(
      `
      UPDATE auth_sessions
      SET status = 'expired', revoked_at = now(), revoke_reason = 'expired'
      WHERE session_id = $1 AND status = 'active'
      `,
      [current.session_id],
    );
  }

  private async revokeTokenFamily(
    tx: TransactionClient,
    current: Pick<RefreshSessionRow, 'token_family_id' | 'session_id'>,
    reason: string,
  ): Promise<void> {
    await tx.query(
      `
      UPDATE refresh_tokens
      SET revoked_at = COALESCE(revoked_at, now()),
          revoked_reason = COALESCE(revoked_reason, $2)
      WHERE token_family_id = $1
      `,
      [current.token_family_id, reason],
    );
    await tx.query(
      `
      UPDATE auth_sessions
      SET status = 'revoked', revoked_at = now(), revoke_reason = $2
      WHERE session_id = $1 AND status = 'active'
      `,
      [current.session_id, reason],
    );
  }

  private refreshTokenExpiresAt(): Date {
    return new Date(Date.now() + this.options.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  }

  private hashRefreshToken(refreshToken: string): string {
    return this.tokenService.hashRefreshToken(refreshToken, this.options.refreshTokenPepper);
  }

  private async writeAudit(tx: TransactionClient, input: AuthAuditInput): Promise<void> {
    const role = mapRoleIdToRole(Number(input.roleId));

    await tx.query(
      `
      INSERT INTO audit_log (
        event, entity_type, entity_id, user_id, username, role_code, role,
        request_id, ip_address, user_agent, source, metadata_json
      )
      VALUES ($1, 'auth_session', $2, $3, $4, $5, $5, $6, $7::inet, $8, $9, $10::jsonb)
      `,
      [
        input.event,
        input.sessionId,
        toNullableUserId(input.userId),
        input.username,
        role,
        input.requestId ?? DEFAULT_REQUEST_ID,
        input.ipAddress ?? null,
        input.userAgent ?? null,
        input.authSource ?? 'backend',
        JSON.stringify({
          sessionId: input.sessionId,
          tokenFamilyId: input.tokenFamilyId,
          ...input.metadata,
        }),
      ],
    );
  }

  private async writeCurrentUserLogoutAudit(
    tx: TransactionClient,
    command: LogoutCommand & { currentUser: CurrentUser & { sessionId: string } },
  ): Promise<void> {
    await tx.query(
      `
      INSERT INTO audit_log (
        event, entity_type, entity_id, user_id, username, role_code, role,
        request_id, ip_address, user_agent, source, metadata_json
      )
      VALUES ('auth.logout', 'auth_session', $1, $2, $3, $4, $4, $5, $6::inet, $7, 'backend', $8::jsonb)
      `,
      [
        command.currentUser.sessionId,
        toNullableUserId(command.currentUser.id),
        command.currentUser.username,
        command.currentUser.role,
        command.requestId ?? DEFAULT_REQUEST_ID,
        command.ipAddress ?? null,
        command.userAgent ?? null,
        JSON.stringify({
          sessionId: command.currentUser.sessionId,
          reason: 'logout',
          refreshTokenPresent: false,
        }),
      ],
    );
  }

  private toCurrentUser(row: RefreshSessionRow, sessionId: string): CurrentUser {
    const roleId = Number(row.role_id);
    const role = mapRoleIdToRole(roleId);

    if (!role) {
      throw new ApiError(500, 'UNKNOWN_ROLE', 'User role is not supported by backend', {
        roleId,
      });
    }

    return {
      id: String(row.user_id),
      username: row.username,
      role,
      roleId,
      permissions: getPermissionsForRole(role),
      sessionId,
    };
  }

  private toAuthResponse(user: CurrentUser, issuedAccessToken: IssuedAccessToken): AuthResponse {
    return {
      accessToken: issuedAccessToken.accessToken,
      accessTokenExpiresAt: issuedAccessToken.expiresAt.toISOString(),
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        roleId: user.roleId,
        permissions: user.permissions,
      },
    };
  }
}

function toNullableUserId(userId: string | number): number | null {
  const parsed = Number(userId);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

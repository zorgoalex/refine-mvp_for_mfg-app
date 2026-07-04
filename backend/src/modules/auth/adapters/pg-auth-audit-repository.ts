import { DatabaseService } from '../../../database/database.service';
import { mapRoleIdToRole } from '../../../permissions/permissions';
import type { AuthAuditPort, AuthSource, AuthUserRecord, LoginFailedReason } from '../auth.types';

const DEFAULT_REQUEST_ID = 'auth-command';

export class PgAuthAuditRepository implements AuthAuditPort {
  constructor(private readonly database: DatabaseService) {}

  async writeLoginFailed(input: {
    username: string;
    user?: Pick<AuthUserRecord, 'id' | 'username' | 'roleId' | 'isActive'>;
    reason: LoginFailedReason;
    requestId?: string;
    userAgent?: string;
    ipAddress?: string;
    authSource?: AuthSource;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const role = input.user ? mapRoleIdToRole(input.user.roleId) : null;

    await this.database.query(
      `
      INSERT INTO audit_log (
        event, entity_type, entity_id, user_id, username, role_code, role,
        related_user_id, request_id, ip_address, user_agent, source, metadata_json
      )
      VALUES (
        'auth.login.failed', 'auth', $1, $2, $3, $4, $4,
        $5, $6, $7::inet, $8, $9, $10::jsonb
      )
      `,
      [
        input.user?.id ?? input.username,
        toNullableUserId(input.user?.id),
        input.user?.username ?? input.username,
        role,
        // Query-ready dimension (plan §4.8): the resolved account, when known.
        toNullableUserId(input.user?.id),
        input.requestId ?? DEFAULT_REQUEST_ID,
        input.ipAddress ?? null,
        input.userAgent ?? null,
        input.authSource ?? 'backend',
        JSON.stringify({
          attemptedUsername: input.username,
          reason: input.reason,
          userKnown: Boolean(input.user),
          userActive: input.user?.isActive ?? null,
          ...input.metadata,
        }),
      ],
    );
  }
}

function toNullableUserId(userId: string | undefined): number | null {
  if (!userId) {
    return null;
  }

  const parsed = Number(userId);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

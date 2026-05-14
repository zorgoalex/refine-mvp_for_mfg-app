import { DatabaseService } from '../../../database/database.service';
import { mapRoleIdToRole } from '../../../permissions/permissions';
import type { AuthAuditPort, AuthUserRecord } from '../auth.types';

const DEFAULT_REQUEST_ID = 'auth-command';

export class PgAuthAuditRepository implements AuthAuditPort {
  constructor(private readonly database: DatabaseService) {}

  async writeLoginFailed(input: {
    username: string;
    user?: Pick<AuthUserRecord, 'id' | 'username' | 'roleId' | 'isActive'>;
    reason: 'unknown_user' | 'invalid_password' | 'inactive_user';
    requestId?: string;
    userAgent?: string;
    ipAddress?: string;
  }): Promise<void> {
    const role = input.user ? mapRoleIdToRole(input.user.roleId) : null;

    await this.database.query(
      `
      INSERT INTO audit_log (
        event, entity_type, entity_id, user_id, username, role_code, role,
        request_id, ip_address, user_agent, source, metadata_json
      )
      VALUES (
        'auth.login.failed', 'auth', $1, $2, $3, $4, $4,
        $5, $6::inet, $7, 'backend', $8::jsonb
      )
      `,
      [
        input.user?.id ?? input.username,
        toNullableUserId(input.user?.id),
        input.user?.username ?? input.username,
        role,
        input.requestId ?? DEFAULT_REQUEST_ID,
        input.ipAddress ?? null,
        input.userAgent ?? null,
        JSON.stringify({
          attemptedUsername: input.username,
          reason: input.reason,
          userKnown: Boolean(input.user),
          userActive: input.user?.isActive ?? null,
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

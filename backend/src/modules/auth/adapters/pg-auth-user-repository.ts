import type { QueryResultRow } from 'pg';
import { DatabaseService } from '../../../database/database.service';
import type { AuthUserRecord, AuthUserRepositoryPort, LoginPolicy } from '../auth.types';

interface AuthUserRow extends QueryResultRow {
  user_id: string | number;
  username: string;
  role_id: string | number;
  password_hash: string;
  is_active: boolean;
  login_policy?: string;
}

export interface PgAuthUserRepositoryOptions {
  /**
   * users.login_policy exists only after migration 052. The column is selected
   * only when the WorkOS flag is enabled (same operational window as the
   * migration), so the backend stays deployable against a pre-052 database.
   */
  includeLoginPolicy?: boolean;
}

export class PgAuthUserRepository implements AuthUserRepositoryPort {
  constructor(
    private readonly database: DatabaseService,
    private readonly options: PgAuthUserRepositoryOptions = {},
  ) {}

  async findByUsername(username: string): Promise<AuthUserRecord | null> {
    const loginPolicySelect = this.options.includeLoginPolicy ? ', login_policy' : '';
    const result = await this.database.query<AuthUserRow>(
      `
      SELECT user_id, username, role_id, password_hash, is_active${loginPolicySelect}
      FROM users
      WHERE username = $1 OR email = $1
      LIMIT 1
      `,
      [username],
    );
    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return {
      id: String(row.user_id),
      username: row.username,
      roleId: Number(row.role_id),
      passwordHash: row.password_hash,
      isActive: row.is_active,
      loginPolicy: toLoginPolicy(row.login_policy),
    };
  }
}

function toLoginPolicy(value: string | undefined): LoginPolicy {
  return value === 'local' || value === 'external' ? value : 'both';
}

import type { QueryResultRow } from 'pg';
import { DatabaseService } from '../../../database/database.service';
import type { AuthUserRecord, AuthUserRepositoryPort } from '../auth.types';

interface AuthUserRow extends QueryResultRow {
  user_id: string | number;
  username: string;
  role_id: string | number;
  password_hash: string;
  is_active: boolean;
}

export class PgAuthUserRepository implements AuthUserRepositoryPort {
  constructor(private readonly database: DatabaseService) {}

  async findByUsername(username: string): Promise<AuthUserRecord | null> {
    const result = await this.database.query<AuthUserRow>(
      `
      SELECT user_id, username, role_id, password_hash, is_active
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
    };
  }
}

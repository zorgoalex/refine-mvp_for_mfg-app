import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { PgAuthUserRepository } from './pg-auth-user-repository';

describe('PgAuthUserRepository', () => {
  it('maps DB user row into AuthUserRecord', async () => {
    const queries: string[] = [];
    const repository = new PgAuthUserRepository(
      createDatabase([
        {
          user_id: '42',
          username: 'manager',
          role_id: 10,
          password_hash: 'bcrypt-hash',
          is_active: true,
        },
      ], queries),
    );

    await expect(repository.findByUsername('manager')).resolves.toEqual({
      id: '42',
      username: 'manager',
      roleId: 10,
      passwordHash: 'bcrypt-hash',
      isActive: true,
      loginPolicy: 'both',
    });
    expect(queries[0]).toContain('is_service_account = false');
  });

  it('enforces stored login_policy when the column is selected (flag-off keeps external-only closed)', async () => {
    const repository = new PgAuthUserRepository(
      createDatabase([
        {
          user_id: '42',
          username: 'manager',
          role_id: 10,
          password_hash: 'bcrypt-hash',
          is_active: true,
          login_policy: 'external',
        },
      ]),
      { includeLoginPolicy: true },
    );

    await expect(repository.findByUsername('manager')).resolves.toMatchObject({
      loginPolicy: 'external',
    });
  });

  it('returns null when user is missing', async () => {
    const repository = new PgAuthUserRepository(createDatabase([]));

    await expect(repository.findByUsername('missing')).resolves.toBeNull();
  });
});

function createDatabase(rows: unknown[], queries: string[] = []): DatabaseService {
  return {
    async query(text: string) {
      queries.push(text);
      return { rows };
    },
  } as unknown as DatabaseService;
}

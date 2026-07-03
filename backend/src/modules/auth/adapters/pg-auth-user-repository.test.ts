import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { PgAuthUserRepository } from './pg-auth-user-repository';

describe('PgAuthUserRepository', () => {
  it('maps DB user row into AuthUserRecord', async () => {
    const repository = new PgAuthUserRepository(
      createDatabase([
        {
          user_id: '42',
          username: 'manager',
          role_id: 10,
          password_hash: 'bcrypt-hash',
          is_active: true,
        },
      ]),
    );

    await expect(repository.findByUsername('manager')).resolves.toEqual({
      id: '42',
      username: 'manager',
      roleId: 10,
      passwordHash: 'bcrypt-hash',
      isActive: true,
      loginPolicy: 'both',
    });
  });

  it('returns null when user is missing', async () => {
    const repository = new PgAuthUserRepository(createDatabase([]));

    await expect(repository.findByUsername('missing')).resolves.toBeNull();
  });
});

function createDatabase(rows: unknown[]): DatabaseService {
  return {
    async query() {
      return { rows };
    },
  } as unknown as DatabaseService;
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyAdminToken } from '../_lib/verify-token';
import { hashPassword } from '../_lib/password';
import { hasuraAdminQuery } from '../_lib/db';
import { logger } from '../_lib/logger';

/**
 * POST /api/users/create
 *
 * Создает нового пользователя (доступно только администратору)
 *
 * Headers:
 *   - Authorization: Bearer <admin_access_token>
 *
 * Body:
 *   - username: string (обязательно)
 *   - email: string (обязательно)
 *   - password: string (обязательно, минимум 6 символов)
 *   - role: string (admin|manager|operator|top_manager|worker|viewer)
 *   - full_name?: string (опционально)
 *   - is_active?: boolean (опционально, по умолчанию true)
 *
 * Response:
 *   - user: { user_id, username, email, role, full_name, is_active }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1. Проверить права администратора
    const admin = verifyAdminToken(req);

    if (!admin) {
      logger.warn('Unauthorized user creation attempt');
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }

    // 2. Валидация входных данных
    const { username, email, password, role, full_name, is_active = true } = req.body;

    if (!username || !email || !password || !role) {
      return res.status(400).json({
        error: 'Missing required fields: username, email, password, role'
      });
    }

    // Валидация длины пароля
    if (password.length < 6) {
      return res.status(400).json({
        error: 'Password must be at least 6 characters long'
      });
    }

    // Валидация роли
    const validRoles = ['admin', 'manager', 'operator', 'top_manager', 'worker', 'viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({
        error: `Invalid role. Must be one of: ${validRoles.join(', ')}`
      });
    }

    // 3. Проверить, существует ли пользователь с таким username или email
    const existingUserData = await hasuraAdminQuery<{ users: Array<{ user_id: string; username: string; email: string }> }>(
      `
      query CheckExistingUser($username: citext!, $email: citext!) {
        users(where: {_or: [{username: {_eq: $username}}, {email: {_eq: $email}}]}) {
          user_id
          username
          email
        }
      }
      `,
      { username, email }
    );

    if (existingUserData.users.length > 0) {
      const existing = existingUserData.users[0];
      const field = existing.username === username ? 'username' : 'email';
      logger.warn('User creation failed: duplicate', { field, value: existing[field] });
      return res.status(409).json({
        error: `User with this ${field} already exists`
      });
    }

    // 4. Хэшировать пароль
    const password_hash = await hashPassword(password);

    // 5. Маппинг роли на role_id
    const roleIdMap: Record<string, number> = {
      admin: 1,
      manager: 10,
      operator: 11,
      top_manager: 15,
      worker: 20,
      viewer: 100,
    };

    const role_id = roleIdMap[role];

    // 6. Вставить нового пользователя в БД
    const insertData = await hasuraAdminQuery<{
      insert_users_one: {
        user_id: string;
        username: string;
        email: string;
        full_name: string | null;
        role_id: number;
        is_active: boolean;
        created_at: string;
      };
    }>(
      `
      mutation CreateUser(
        $username: citext!,
        $email: citext!,
        $password_hash: String!,
        $role_id: smallint!,
        $full_name: String,
        $is_active: Boolean!
      ) {
        insert_users_one(object: {
          username: $username,
          email: $email,
          password_hash: $password_hash,
          role_id: $role_id,
          full_name: $full_name,
          is_active: $is_active
        }) {
          user_id
          username
          email
          full_name
          role_id
          is_active
          created_at
        }
      }
      `,
      {
        username,
        email,
        password_hash,
        role_id,
        full_name: full_name || null,
        is_active,
      }
    );

    const newUser = insertData.insert_users_one;

    logger.info('User created successfully', {
      userId: newUser.user_id,
      username: newUser.username,
      createdBy: admin.username,
    });

    // 7. Вернуть данные созданного пользователя (без password_hash)
    return res.status(201).json({
      user: {
        user_id: newUser.user_id,
        username: newUser.username,
        email: newUser.email,
        full_name: newUser.full_name,
        role,
        is_active: newUser.is_active,
        created_at: newUser.created_at,
      },
    });

  } catch (error) {
    logger.error('User creation error', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

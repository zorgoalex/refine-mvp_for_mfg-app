interface User {
  user_id: string;
  username: string;
  password_hash: string;
  role_id: number;
  role: {
    role_name: string;
  };
  is_active: boolean;
  allowed_roles?: string[];
}

const HASURA_URL = process.env.HASURA_URL!;
const HASURA_ADMIN_SECRET = process.env.HASURA_ADMIN_SECRET!;

/**
 * Выполняет GraphQL запрос к Hasura с правами администратора
 */
export async function hasuraAdminQuery<T = any>(
  query: string,
  variables: any = {}
): Promise<T> {
  const response = await fetch(HASURA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hasura-admin-secret': HASURA_ADMIN_SECRET,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Hasura request failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();

  if (json.errors) {
    console.error('Hasura GraphQL errors:', json.errors);
    throw new Error(JSON.stringify(json.errors));
  }

  return json.data as T;
}

/**
 * Получает пользователя по username
 */
export async function getUserByUsername(username: string): Promise<User | null> {
  const data = await hasuraAdminQuery<{ users: User[] }>(
    `
    query GetUser($username: citext!) {
      users(where: {username: {_eq: $username}}) {
        user_id
        username
        password_hash
        role_id
        role {
          role_name
        }
        is_active
      }
    }
    `,
    { username }
  );

  const user = data.users[0];
  if (!user) return null;

  // Маппинг ролей на allowed_roles (иерархия прав)
  const roleMap: Record<string, string[]> = {
    admin: ['admin', 'manager', 'operator', 'top_manager', 'worker', 'viewer'],
    manager: ['manager', 'operator', 'viewer'],
    top_manager: ['top_manager', 'manager', 'operator', 'viewer'],
    operator: ['operator', 'viewer'],
    worker: ['worker', 'viewer'],
    viewer: ['viewer'],
  };

  const roleName = user.role.role_name;

  return {
    ...user,
    allowed_roles: roleMap[roleName] || ['viewer'],
  };
}

/**
 * Получает пользователя по user_id
 */
export async function getUserById(userId: string): Promise<User | null> {
  const data = await hasuraAdminQuery<{ users: User[] }>(
    `
    query GetUserById($userId: bigint!) {
      users(where: {user_id: {_eq: $userId}}) {
        user_id
        username
        password_hash
        role_id
        role {
          role_name
        }
        is_active
      }
    }
    `,
    { userId }
  );

  const user = data.users[0];
  if (!user) return null;

  // Маппинг ролей на allowed_roles
  const roleMap: Record<string, string[]> = {
    admin: ['admin', 'manager', 'operator', 'top_manager', 'worker', 'viewer'],
    manager: ['manager', 'operator', 'viewer'],
    top_manager: ['top_manager', 'manager', 'operator', 'viewer'],
    operator: ['operator', 'viewer'],
    worker: ['worker', 'viewer'],
    viewer: ['viewer'],
  };

  const roleName = user.role.role_name;

  return {
    ...user,
    allowed_roles: roleMap[roleName] || ['viewer'],
  };
}

/**
 * Обновляет last_login_at для пользователя
 */
export async function updateLastLogin(userId: string): Promise<void> {
  await hasuraAdminQuery(
    `
    mutation UpdateLastLogin($userId: bigint!) {
      update_users_by_pk(
        pk_columns: {user_id: $userId},
        _set: {last_login_at: "now()"}
      ) {
        user_id
      }
    }
    `,
    { userId }
  );
}

/**
 * Сохраняет refresh token в БД (SHA256 hash)
 */
export async function storeRefreshToken(
  userId: string,
  tokenHash: string,
  expiresAt: Date,
  userAgent?: string,
  ipAddress?: string
): Promise<void> {
  await hasuraAdminQuery(
    `
    mutation StoreRefreshToken(
      $userId: bigint!,
      $tokenHash: String!,
      $expiresAt: timestamp!,
      $userAgent: String,
      $ipAddress: inet
    ) {
      insert_refresh_tokens_one(object: {
        user_id: $userId,
        token_hash: $tokenHash,
        expires_at: $expiresAt,
        user_agent: $userAgent,
        ip_address: $ipAddress
      }) {
        token_id
      }
    }
    `,
    {
      userId,
      tokenHash,
      expiresAt: expiresAt.toISOString(),
      userAgent,
      ipAddress
    }
  );
}

/**
 * Проверяет refresh token hash в БД
 * Возвращает user_id если токен валиден, иначе null
 */
export async function verifyRefreshTokenHash(tokenHash: string): Promise<string | null> {
  const data = await hasuraAdminQuery<{ refresh_tokens: Array<{ user_id: string }> }>(
    `
    query VerifyRefreshToken($tokenHash: String!) {
      refresh_tokens(
        where: {
          token_hash: {_eq: $tokenHash},
          expires_at: {_gt: "now()"},
          revoked_at: {_is_null: true}
        }
      ) {
        user_id
      }
    }
    `,
    { tokenHash }
  );

  return data.refresh_tokens[0]?.user_id || null;
}

/**
 * Отзывает (revoke) refresh token
 */
export async function revokeRefreshToken(tokenHash: string): Promise<void> {
  await hasuraAdminQuery(
    `
    mutation RevokeRefreshToken($tokenHash: String!) {
      update_refresh_tokens(
        where: {token_hash: {_eq: $tokenHash}},
        _set: {revoked_at: "now()"}
      ) {
        affected_rows
      }
    }
    `,
    { tokenHash }
  );
}

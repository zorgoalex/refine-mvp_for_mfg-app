import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!;

interface JWTPayload {
  sub: string; // user_id
  username: string;
  role: string;
  'https://hasura.io/jwt/claims': {
    'x-hasura-allowed-roles': string[];
    'x-hasura-default-role': string;
    'x-hasura-user-id': string;
  };
}

/**
 * Генерирует Access Token (JWT) для пользователя
 * TTL: 10 часов
 */
export function generateAccessToken(
  userId: string,
  username: string,
  role: string,
  allowedRoles: string[]
): string {
  const payload: JWTPayload = {
    sub: userId,
    username,
    role,
    'https://hasura.io/jwt/claims': {
      'x-hasura-allowed-roles': allowedRoles,
      'x-hasura-default-role': role,
      'x-hasura-user-id': userId,
    },
  };

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: '10h', // 10 часов (рабочий день)
    algorithm: 'HS256',
  });
}

/**
 * Генерирует Refresh Token для обновления Access Token
 * TTL: 7 дней
 */
export function generateRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_REFRESH_SECRET, {
    expiresIn: '7d', // 7 дней
    algorithm: 'HS256',
  });
}

/**
 * Проверяет и декодирует Refresh Token
 * Возвращает payload или null если токен невалиден
 */
export function verifyRefreshToken(token: string): { sub: string } | null {
  try {
    return jwt.verify(token, JWT_REFRESH_SECRET) as { sub: string };
  } catch (error) {
    console.error('JWT verification failed:', error);
    return null;
  }
}

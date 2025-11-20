import jwt from 'jsonwebtoken';
import type { VercelRequest } from '@vercel/node';

const JWT_SECRET = process.env.JWT_SECRET!;

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

export interface VerifiedUser {
  userId: string;
  username: string;
  role: string;
}

/**
 * Извлекает токен из заголовка Authorization
 * Поддерживает формат: "Bearer <token>"
 */
export function extractToken(req: VercelRequest): string | null {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return null;
  }

  // Формат: "Bearer <token>"
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }

  return parts[1];
}

/**
 * Проверяет JWT токен и декодирует его
 * Возвращает данные пользователя или null если токен невалиден
 */
export function verifyToken(token: string): VerifiedUser | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload;

    return {
      userId: decoded.sub,
      username: decoded.username,
      role: decoded.role,
    };
  } catch (error) {
    console.error('JWT verification failed:', error);
    return null;
  }
}

/**
 * Проверяет, является ли пользователь администратором
 */
export function isAdmin(user: VerifiedUser): boolean {
  return user.role === 'admin';
}

/**
 * Извлекает и проверяет токен из запроса, проверяет права администратора
 * Возвращает данные пользователя или null если токен невалиден или пользователь не админ
 */
export function verifyAdminToken(req: VercelRequest): VerifiedUser | null {
  const token = extractToken(req);

  if (!token) {
    return null;
  }

  const user = verifyToken(token);

  if (!user || !isAdmin(user)) {
    return null;
  }

  return user;
}

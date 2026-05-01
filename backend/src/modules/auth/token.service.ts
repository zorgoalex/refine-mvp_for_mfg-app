import { createHmac, randomBytes } from 'node:crypto';

export class TokenService {
  generateRefreshToken(byteLength = 64): string {
    return randomBytes(byteLength).toString('base64url');
  }

  hashRefreshToken(refreshToken: string, pepper: string): string {
    return createHmac('sha256', pepper).update(refreshToken).digest('hex');
  }
}

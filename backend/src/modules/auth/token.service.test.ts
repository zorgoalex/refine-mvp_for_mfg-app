import { describe, expect, it } from 'vitest';
import { TokenService } from './token.service';

describe('TokenService refresh token helpers', () => {
  const service = new TokenService();

  it('generates opaque base64url refresh tokens', () => {
    const token = service.generateRefreshToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThan(80);
  });

  it('hashes refresh tokens with pepper', () => {
    expect(service.hashRefreshToken('refresh', 'pepper1')).toMatch(/^[a-f0-9]{64}$/);
    expect(service.hashRefreshToken('refresh', 'pepper1')).toBe(
      service.hashRefreshToken('refresh', 'pepper1'),
    );
    expect(service.hashRefreshToken('refresh', 'pepper1')).not.toBe(
      service.hashRefreshToken('refresh', 'pepper2'),
    );
  });
});

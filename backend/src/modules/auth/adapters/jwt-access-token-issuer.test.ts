import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { JwtAccessTokenIssuer } from './jwt-access-token-issuer';

describe('JwtAccessTokenIssuer', () => {
  const issuer = new JwtAccessTokenIssuer(
    'test-access-secret-with-at-least-32-chars',
    900,
    () => new Date('2026-05-01T12:00:00.000Z'),
  );

  it('issues and verifies access tokens with current user claims', async () => {
    const issued = await issuer.issueAccessToken(currentUser());

    expect(issued.expiresAt.toISOString()).toBe('2026-05-01T12:15:00.000Z');
    expect(issuer.verifyAccessToken(issued.accessToken)).toMatchObject({
      id: '10',
      username: 'manager',
      role: 'manager',
      roleId: 10,
      sessionId: 'session-1',
    });
  });

  it('rejects invalid access tokens', () => {
    expect(() => issuer.verifyAccessToken('not-a-jwt')).toThrow(/Access token is invalid/);
  });
});

function currentUser(): CurrentUser {
  return {
    id: '10',
    username: 'manager',
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'),
    sessionId: 'session-1',
  };
}

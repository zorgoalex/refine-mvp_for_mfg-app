import { describe, expect, it, vi } from 'vitest';
import { Bitrix24TokenCipher } from './bitrix24-token-cipher';
import { Bitrix24OAuthTokenService } from './bitrix24-oauth-token.service';

describe('Bitrix24OAuthTokenService', () => {
  it('decrypts a valid installed access token for OAuth REST calls', async () => {
    const key = Buffer.alloc(32, 5).toString('base64');
    const cipher = new Bitrix24TokenCipher(key);
    const repository = {
      getInstallationByDomain: vi.fn().mockResolvedValue({
        memberId: 'member-1',
        domain: 'mebelkz.bitrix24.kz',
        accessTokenCiphertext: cipher.encrypt('current-access'),
        refreshTokenCiphertext: cipher.encrypt('current-refresh'),
        accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000),
        applicationTokenHash: 'a'.repeat(64),
        status: 'active',
      }),
      claimInstallationRefresh: vi.fn(),
    };
    const config = {
      getReverseSync: () => ({
        enabled: true,
        appClientId: 'local.1',
        appClientSecret: 'secret',
        tokenEncryptionKey: key,
      }),
    };
    const service = new Bitrix24OAuthTokenService(
      repository as never,
      config as never,
      vi.fn(),
    );

    await expect(
      service.getAccessToken('mebelkz.bitrix24.kz'),
    ).resolves.toBe('current-access');
    expect(repository.claimInstallationRefresh).not.toHaveBeenCalled();
  });

  it('rotates encrypted tokens and verifies portal context', async () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const cipher = new Bitrix24TokenCipher(key);
    const repository = {
      claimInstallationRefresh: vi.fn().mockResolvedValue({
        memberId: 'member-1',
        domain: 'mebelkz.bitrix24.kz',
        accessTokenCiphertext: cipher.encrypt('old-access'),
        refreshTokenCiphertext: cipher.encrypt('old-refresh'),
        lockToken: '00000000-0000-4000-8000-000000000001',
      }),
      completeInstallationRefresh: vi.fn().mockResolvedValue(true),
      failInstallationRefresh: vi.fn(),
    };
    const config = {
      getReverseSync: () => ({
        enabled: true,
        relayOwner: 'in_process',
        dryRun: false,
        appClientId: 'local.1',
        appClientSecret: 'secret',
        tokenEncryptionKey: key,
      }),
    };
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600,
      domain: 'oauth.bitrix24.tech',
      client_endpoint: 'https://mebelkz.bitrix24.kz/rest/',
      member_id: 'member-1',
    }), { status: 200 }));

    const service = new Bitrix24OAuthTokenService(
      repository as never,
      config as never,
      fetchFn,
    );
    await expect(service.runTick()).resolves.toEqual({ refreshed: 1, failed: 0 });
    const completed = repository.completeInstallationRefresh.mock.calls[0][0];
    expect(cipher.decrypt(completed.accessTokenCiphertext)).toBe('new-access');
    expect(cipher.decrypt(completed.refreshTokenCiphertext)).toBe('new-refresh');
    expect(repository.failInstallationRefresh).not.toHaveBeenCalled();
    const submitted = fetchFn.mock.calls[0][1]?.body as URLSearchParams;
    expect(submitted.get('refresh_token')).toBe('old-refresh');
  });

  it('fails closed when refreshed context belongs to another member', async () => {
    const key = Buffer.alloc(32, 9).toString('base64');
    const cipher = new Bitrix24TokenCipher(key);
    const repository = {
      claimInstallationRefresh: vi.fn().mockResolvedValue({
        memberId: 'member-1',
        domain: 'mebelkz.bitrix24.kz',
        accessTokenCiphertext: cipher.encrypt('old-access'),
        refreshTokenCiphertext: cipher.encrypt('old-refresh'),
        lockToken: '00000000-0000-4000-8000-000000000001',
      }),
      completeInstallationRefresh: vi.fn(),
      failInstallationRefresh: vi.fn(),
    };
    const config = {
      getReverseSync: () => ({
        enabled: true,
        relayOwner: 'in_process',
        dryRun: false,
        appClientId: 'local.1',
        appClientSecret: 'secret',
        tokenEncryptionKey: key,
      }),
    };
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600,
      domain: 'oauth.bitrix24.tech',
      client_endpoint: 'https://mebelkz.bitrix24.kz/rest/',
      member_id: 'member-2',
    }), { status: 200 }));

    const service = new Bitrix24OAuthTokenService(
      repository as never,
      config as never,
      fetchFn,
    );
    await expect(service.runTick()).resolves.toEqual({ refreshed: 0, failed: 1 });
    expect(repository.completeInstallationRefresh).not.toHaveBeenCalled();
    expect(repository.failInstallationRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('BITRIX24_OAUTH_CONTEXT_MISMATCH'),
      }),
    );
  });

  it('fails closed when refreshed client endpoint belongs to another portal', async () => {
    const key = Buffer.alloc(32, 11).toString('base64');
    const cipher = new Bitrix24TokenCipher(key);
    const repository = {
      claimInstallationRefresh: vi.fn().mockResolvedValue({
        memberId: 'member-1',
        domain: 'mebelkz.bitrix24.kz',
        accessTokenCiphertext: cipher.encrypt('old-access'),
        refreshTokenCiphertext: cipher.encrypt('old-refresh'),
        lockToken: '00000000-0000-4000-8000-000000000001',
      }),
      completeInstallationRefresh: vi.fn(),
      failInstallationRefresh: vi.fn(),
    };
    const config = {
      getReverseSync: () => ({
        enabled: true,
        relayOwner: 'in_process',
        dryRun: false,
        appClientId: 'local.1',
        appClientSecret: 'secret',
        tokenEncryptionKey: key,
      }),
    };
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      domain: 'oauth.bitrix24.tech',
      client_endpoint: 'https://other.bitrix24.kz/rest/',
      member_id: 'member-1',
    }), { status: 200 }));

    const service = new Bitrix24OAuthTokenService(
      repository as never,
      config as never,
      fetchFn,
    );
    await expect(service.runTick()).resolves.toEqual({ refreshed: 0, failed: 1 });
    expect(repository.completeInstallationRefresh).not.toHaveBeenCalled();
    expect(repository.failInstallationRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('BITRIX24_OAUTH_CONTEXT_MISMATCH'),
      }),
    );
  });
});

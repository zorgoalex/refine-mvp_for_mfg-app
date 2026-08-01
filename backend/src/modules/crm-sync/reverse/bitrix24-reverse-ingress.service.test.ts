import { describe, expect, it, vi } from 'vitest';
import { Bitrix24ReverseIngressService } from './bitrix24-reverse-ingress.service';
import { hashBitrix24ApplicationToken } from './bitrix24-token-cipher';

const installationBody = {
  auth: {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: '3600',
    domain: 'mebelkz.bitrix24.kz',
    member_id: 'member-123456',
    status: 'L',
    application_token: 'application-secret',
  },
};

function config() {
  return {
    getReverseSync: () => ({
      enabled: true,
      appClientId: 'local.erp',
      tokenEncryptionKey: Buffer.alloc(32, 3).toString('base64'),
      publicBaseUrl: 'https://backend.example',
      portalDomain: 'mebelkz.bitrix24.kz',
      apiPrefix: '/api/v1',
    }),
  };
}

describe('Bitrix24ReverseIngressService', () => {
  it('verifies app identity, stores encrypted installation, and binds events', async () => {
    const repository = {
      saveInstallation: vi.fn(),
      markInstallationError: vi.fn(),
    };
    const localApp = {
      verify: vi.fn(),
      bindRequiredEvents: vi.fn(),
    };
    const service = new Bitrix24ReverseIngressService(
      repository as never,
      config() as never,
      localApp as never,
    );

    await expect(service.install(installationBody, 'request-1')).resolves.toEqual({
      status: 'success',
    });
    expect(localApp.verify).toHaveBeenCalledWith({
      domain: 'mebelkz.bitrix24.kz',
      accessToken: 'access-token',
      expectedAppCode: 'local.erp',
    });
    expect(repository.saveInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        accessTokenCiphertext: expect.not.stringContaining('access-token'),
        refreshTokenCiphertext: expect.not.stringContaining('refresh-token'),
        applicationTokenHash: hashBitrix24ApplicationToken('application-secret'),
      }),
    );
    expect(localApp.bindRequiredEvents).toHaveBeenCalledWith({
      domain: 'mebelkz.bitrix24.kz',
      accessToken: 'access-token',
      handlerUrl: 'https://backend.example/api/v1/integrations/bitrix24/events',
    });
  });

  it('rejects an installation when app.info cannot verify the local app', async () => {
    const repository = {
      saveInstallation: vi.fn(),
    };
    const localApp = {
      verify: vi.fn().mockRejectedValue(new Error('app mismatch')),
    };
    const service = new Bitrix24ReverseIngressService(
      repository as never,
      config() as never,
      localApp as never,
    );

    await expect(service.install(installationBody, 'request-1')).rejects.toThrow(
      'app mismatch',
    );
    expect(repository.saveInstallation).not.toHaveBeenCalled();
  });

  it('rejects event delivery with a token different from the installed app', async () => {
    const repository = {
      getInstallation: vi.fn().mockResolvedValue({
        memberId: 'member-123456',
        domain: 'mebelkz.bitrix24.kz',
        status: 'active',
        applicationTokenHash: hashBitrix24ApplicationToken('expected-token'),
      }),
      enqueueEvent: vi.fn(),
    };
    const service = new Bitrix24ReverseIngressService(
      repository as never,
      config() as never,
      {} as never,
    );

    await expect(service.receiveEvent({
      event: 'ONCRMDEALUPDATE',
      data: { FIELDS: { ID: 42 } },
      ts: Math.floor(Date.now() / 1000),
      auth: {
        domain: 'mebelkz.bitrix24.kz',
        member_id: 'member-123456',
        application_token: 'attacker-token',
      },
    })).rejects.toMatchObject({ code: 'BITRIX24_EVENT_AUTH_FAILED' });
    expect(repository.enqueueEvent).not.toHaveBeenCalled();
  });
});

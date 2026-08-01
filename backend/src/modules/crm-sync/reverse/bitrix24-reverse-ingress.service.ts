import { ApiError } from '../../../common/errors/api-error';
import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import { Bitrix24LocalAppClient } from './bitrix24-local-app-client';
import {
  parseBitrix24InboundEvent,
  parseBitrix24InstallationPayload,
} from './bitrix24-reverse-payload';
import {
  Bitrix24TokenCipher,
  hashBitrix24ApplicationToken,
  matchesBitrix24ApplicationToken,
} from './bitrix24-token-cipher';
import { PgBitrix24ReverseRepository } from './pg-bitrix24-reverse-repository';

export class Bitrix24ReverseIngressService {
  constructor(
    private readonly repository: PgBitrix24ReverseRepository,
    private readonly config: CrmSyncRuntimeConfigService,
    private readonly localApp: Bitrix24LocalAppClient,
  ) {}

  async install(body: unknown, requestId: string): Promise<{
    status: 'success';
  }> {
    const settings = this.requireEnabled();
    const payload = parseBitrix24InstallationPayload(body);
    this.assertPortal(payload.domain, settings.portalDomain);
    if (payload.applicationStatus !== 'L') {
      throw new ApiError(
        403,
        'BITRIX24_APP_CONTEXT_INVALID',
        'Only a local Bitrix24 application can install reverse sync',
      );
    }
    if (
      !settings.appClientId ||
      !settings.tokenEncryptionKey ||
      !settings.publicBaseUrl
    ) {
      throw unavailable();
    }

    await this.localApp.verify({
      domain: payload.domain,
      accessToken: payload.accessToken,
      expectedAppCode: settings.appClientId,
    });

    const cipher = new Bitrix24TokenCipher(settings.tokenEncryptionKey);
    await this.repository.saveInstallation({
      payload,
      accessTokenCiphertext: cipher.encrypt(payload.accessToken),
      refreshTokenCiphertext: cipher.encrypt(payload.refreshToken),
      applicationTokenHash: hashBitrix24ApplicationToken(payload.applicationToken),
      requestId,
    });

    const handlerUrl =
      `${settings.publicBaseUrl}${settings.apiPrefix}/integrations/bitrix24/events`;
    try {
      await this.localApp.bindRequiredEvents({
        domain: payload.domain,
        accessToken: payload.accessToken,
        handlerUrl,
      });
    } catch (error) {
      await this.repository.markInstallationError(
        payload.memberId,
        safeError(error),
      );
      throw error;
    }

    return { status: 'success' };
  }

  async receiveEvent(body: unknown): Promise<{ accepted: true }> {
    const settings = this.requireEnabled();
    const event = parseBitrix24InboundEvent(body);
    this.assertPortal(event.domain, settings.portalDomain);
    const installation = await this.repository.getInstallation(event.memberId);
    if (
      !installation ||
      installation.status === 'revoked' ||
      installation.domain !== event.domain ||
      !matchesBitrix24ApplicationToken(
        event.applicationToken,
        installation.applicationTokenHash,
      )
    ) {
      throw new ApiError(
        403,
        'BITRIX24_EVENT_AUTH_FAILED',
        'Bitrix24 event authentication failed',
      );
    }
    await this.repository.enqueueEvent(event);
    return { accepted: true };
  }

  private requireEnabled(): ReturnType<CrmSyncRuntimeConfigService['getReverseSync']> {
    const settings = this.config.getReverseSync();
    if (!settings.enabled) throw unavailable();
    return settings;
  }

  private assertPortal(actual: string, expected: string): void {
    if (actual !== expected) {
      throw new ApiError(
        403,
        'BITRIX24_PORTAL_DENIED',
        'Bitrix24 callback portal is not allowed',
      );
    }
  }
}

function unavailable(): ApiError {
  return new ApiError(
    503,
    'BITRIX24_REVERSE_SYNC_DISABLED',
    'Bitrix24 reverse sync is not configured',
  );
}

function safeError(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`.slice(0, 1000);
  return 'BITRIX24_APP_REQUEST_FAILED';
}

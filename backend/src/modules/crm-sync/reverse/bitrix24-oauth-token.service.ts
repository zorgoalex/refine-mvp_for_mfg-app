import { ApiError } from '../../../common/errors/api-error';
import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import { Bitrix24TokenCipher } from './bitrix24-token-cipher';
import { PgBitrix24ReverseRepository } from './pg-bitrix24-reverse-repository';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

interface RefreshEnvelope {
  access_token?: unknown;
  refresh_token?: unknown;
  expires?: unknown;
  expires_in?: unknown;
  domain?: unknown;
  client_endpoint?: unknown;
  member_id?: unknown;
  error?: unknown;
}

export class Bitrix24OAuthTokenService {
  constructor(
    private readonly repository: PgBitrix24ReverseRepository,
    private readonly config: CrmSyncRuntimeConfigService,
    private readonly fetchFn: FetchFn = fetch as unknown as FetchFn,
  ) {}

  async runTick(): Promise<{ refreshed: number; failed: number }> {
    const settings = this.config.getReverseSync();
    if (!settings.enabled || settings.relayOwner === 'none' || settings.dryRun) {
      return { refreshed: 0, failed: 0 };
    }
    if (
      !settings.appClientId ||
      !settings.appClientSecret ||
      !settings.tokenEncryptionKey
    ) {
      return { refreshed: 0, failed: 0 };
    }
    const credentials = {
      appClientId: settings.appClientId,
      appClientSecret: settings.appClientSecret,
      tokenEncryptionKey: settings.tokenEncryptionKey,
    };

    const lease = await this.repository.claimInstallationRefresh({
      refreshLeadMs: 10 * 60_000,
      leaseMs: 2 * 60_000,
    });
    if (!lease) return { refreshed: 0, failed: 0 };

    try {
      await this.refreshLease(lease, credentials);
      return { refreshed: 1, failed: 0 };
    } catch (error) {
      await this.repository.failInstallationRefresh({
        memberId: lease.memberId,
        lockToken: lease.lockToken,
        error: safeRefreshError(error),
      });
      return { refreshed: 0, failed: 1 };
    }
  }

  async getAccessToken(domain: string): Promise<string> {
    const settings = this.requireCredentials();
    let installation = await this.repository.getInstallationByDomain(domain);
    if (!installation || installation.status === 'revoked') {
      throw new ApiError(
        503,
        'BITRIX24_APP_NOT_INSTALLED',
        'Bitrix24 local application is not installed',
      );
    }
    if (installation.accessTokenExpiresAt.getTime() <= Date.now() + 60_000) {
      await this.refreshDomain(domain, false, settings);
      installation = await this.repository.getInstallationByDomain(domain);
      if (!installation || installation.status === 'revoked') {
        throw new ApiError(
          503,
          'BITRIX24_APP_NOT_INSTALLED',
          'Bitrix24 local application is not installed',
        );
      }
    }
    return new Bitrix24TokenCipher(settings.tokenEncryptionKey)
      .decrypt(installation.accessTokenCiphertext);
  }

  async forceRefreshAccessToken(domain: string): Promise<void> {
    await this.refreshDomain(domain, true, this.requireCredentials());
  }

  async refreshCallerToken(input: {
    domain: string;
    memberId: string;
    refreshToken: string;
  }): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
    const settings = this.requireCredentials();
    const refreshed = await this.refresh({
      clientId: settings.appClientId,
      clientSecret: settings.appClientSecret,
      refreshToken: input.refreshToken,
    });
    if (refreshed.domain !== input.domain || refreshed.memberId !== input.memberId) {
      throw new ApiError(
        502,
        'BITRIX24_OAUTH_CONTEXT_MISMATCH',
        'Bitrix24 OAuth refresh returned another portal context',
      );
    }
    return {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
    };
  }

  private async refreshDomain(
    domain: string,
    force: boolean,
    settings: ReturnType<CrmSyncRuntimeConfigService['getReverseSync']> & {
      appClientId: string;
      appClientSecret: string;
      tokenEncryptionKey: string;
    },
  ): Promise<void> {
    const lease = await this.repository.claimInstallationRefresh({
      refreshLeadMs: 10 * 60_000,
      leaseMs: 2 * 60_000,
      domain,
      force,
    });
    if (!lease) {
      if (force) {
        throw new ApiError(
          409,
          'BITRIX24_REFRESH_BUSY',
          'Bitrix24 OAuth refresh is already running',
        );
      }
      return;
    }
    try {
      await this.refreshLease(lease, settings);
    } catch (error) {
      await this.repository.failInstallationRefresh({
        memberId: lease.memberId,
        lockToken: lease.lockToken,
        error: safeRefreshError(error),
      });
      throw error;
    }
  }

  private async refreshLease(
    lease: NonNullable<
      Awaited<ReturnType<PgBitrix24ReverseRepository['claimInstallationRefresh']>>
    >,
    settings: {
      appClientId: string;
      appClientSecret: string;
      tokenEncryptionKey: string;
    },
  ): Promise<void> {
    const cipher = new Bitrix24TokenCipher(settings.tokenEncryptionKey);
    const refreshToken = cipher.decrypt(lease.refreshTokenCiphertext);
    const refreshed = await this.refresh({
      clientId: settings.appClientId,
      clientSecret: settings.appClientSecret,
      refreshToken,
    });
    if (
      refreshed.domain !== lease.domain ||
      refreshed.memberId !== lease.memberId
    ) {
      throw new ApiError(
        502,
        'BITRIX24_OAUTH_CONTEXT_MISMATCH',
        'Bitrix24 OAuth refresh returned another portal context',
      );
    }
    const committed = await this.repository.completeInstallationRefresh({
      memberId: lease.memberId,
      lockToken: lease.lockToken,
      accessTokenCiphertext: cipher.encrypt(refreshed.accessToken),
      refreshTokenCiphertext: cipher.encrypt(refreshed.refreshToken),
      expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
    });
    if (!committed) {
      throw new ApiError(
        409,
        'BITRIX24_REFRESH_LEASE_LOST',
        'Bitrix24 OAuth refresh lease was lost',
      );
    }
  }

  private requireCredentials(): ReturnType<
    CrmSyncRuntimeConfigService['getReverseSync']
  > & {
    appClientId: string;
    appClientSecret: string;
    tokenEncryptionKey: string;
  } {
    const settings = this.config.getReverseSync();
    if (
      !settings.enabled ||
      !settings.appClientId ||
      !settings.appClientSecret ||
      !settings.tokenEncryptionKey
    ) {
      throw new ApiError(
        503,
        'BITRIX24_REVERSE_SYNC_DISABLED',
        'Bitrix24 reverse sync is not configured',
      );
    }
    return settings as typeof settings & {
      appClientId: string;
      appClientSecret: string;
      tokenEncryptionKey: string;
    };
  }

  private async refresh(input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    domain: string;
    memberId: string;
  }> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
    });
    let response: Response;
    try {
      response = await this.fetchFn('https://oauth.bitrix24.tech/oauth/token/', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ApiError(
        502,
        'BITRIX24_OAUTH_NETWORK_ERROR',
        'Bitrix24 OAuth refresh failed',
      );
    }

    const text = await response.text();
    let envelope: RefreshEnvelope;
    try {
      envelope = JSON.parse(text) as RefreshEnvelope;
    } catch {
      throw new ApiError(
        502,
        'BITRIX24_OAUTH_INVALID_RESPONSE',
        'Bitrix24 OAuth refresh returned invalid JSON',
      );
    }
    if (!response.ok || envelope.error !== undefined) {
      throw new ApiError(
        502,
        'BITRIX24_OAUTH_REFRESH_FAILED',
        'Bitrix24 OAuth refresh was rejected',
      );
    }

    const accessToken = requiredString(envelope.access_token);
    const refreshToken = requiredString(envelope.refresh_token);
    const domain = portalDomainFromClientEndpoint(envelope.client_endpoint);
    const memberId = requiredString(envelope.member_id);
    const expiresIn = oauthExpiresIn(envelope);
    if (!Number.isInteger(expiresIn) || expiresIn <= 0 || expiresIn > 86_400) {
      throw new ApiError(
        502,
        'BITRIX24_OAUTH_INVALID_RESPONSE',
        'Bitrix24 OAuth refresh returned invalid expiry',
      );
    }
    return { accessToken, refreshToken, expiresIn, domain, memberId };
  }
}

function portalDomainFromClientEndpoint(value: unknown): string {
  const endpoint = requiredString(value);
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw invalidOAuthResponse();
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    !/^\/rest\/?$/i.test(parsed.pathname) ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw invalidOAuthResponse();
  }
  return parsed.hostname.toLowerCase();
}

function oauthExpiresIn(envelope: RefreshEnvelope): number {
  if (envelope.expires_in !== undefined) return Number(envelope.expires_in);
  const expiresAtSeconds = Number(envelope.expires);
  if (!Number.isFinite(expiresAtSeconds)) return Number.NaN;
  return Math.ceil(expiresAtSeconds - Date.now() / 1000);
}

function invalidOAuthResponse(): ApiError {
  return new ApiError(
    502,
    'BITRIX24_OAUTH_INVALID_RESPONSE',
    'Bitrix24 OAuth refresh returned invalid portal endpoint',
  );
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) {
    throw new ApiError(
      502,
      'BITRIX24_OAUTH_INVALID_RESPONSE',
      'Bitrix24 OAuth refresh returned invalid credentials',
    );
  }
  return value;
}

function safeRefreshError(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`.slice(0, 1000);
  return 'BITRIX24_OAUTH_REFRESH_FAILED';
}

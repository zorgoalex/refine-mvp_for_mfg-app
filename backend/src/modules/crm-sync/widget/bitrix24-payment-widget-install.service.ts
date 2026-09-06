import { randomBytes } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import { Bitrix24LocalAppClient } from '../reverse/bitrix24-local-app-client';
import { parseBitrix24InstallationPayload } from '../reverse/bitrix24-reverse-payload';
import {
  Bitrix24TokenCipher,
  hashBitrix24ApplicationToken,
} from '../reverse/bitrix24-token-cipher';
import { parseRuntimeAuth } from './bitrix24-payment-widget.dto';
import {
  Bitrix24PaymentWidgetRepository,
  hashWidgetToken,
} from './bitrix24-payment-widget.repository';

export class Bitrix24PaymentWidgetInstallService {
  constructor(
    private readonly repository: Bitrix24PaymentWidgetRepository,
    private readonly config: CrmSyncRuntimeConfigService,
    private readonly bitrix: Bitrix24LocalAppClient,
  ) {}

  async begin(body: unknown): Promise<{ state: string; domain: string }> {
    const settings = this.requireEnabled();
    const payload = parseBitrix24InstallationPayload(body);
    this.assertPortal(payload.domain);
    if (payload.applicationStatus !== 'L') throw invalidContext();
    await this.bitrix.verifyPreInstall({
      domain: payload.domain,
      accessToken: payload.accessToken,
      expectedAppCode: settings.appClientId,
    });
    const executor = await this.bitrix.currentUser({
      domain: payload.domain,
      accessToken: payload.accessToken,
    });
    if (!executor.active || !executor.admin) {
      throw new ApiError(
        403,
        'BITRIX24_INSTALL_ADMIN_REQUIRED',
        'Bitrix24 administrator must install the application',
      );
    }
    const handlerUrl = `${settings.publicBaseUrl}${settings.apiPrefix}/integrations/bitrix24/events`;
    const widgetUrl = `${settings.publicBaseUrl}${settings.apiPrefix}/integrations/bitrix24/widget/deal-payment`;
    await this.bitrix.bindRequiredEvents({
      domain: payload.domain,
      accessToken: payload.accessToken,
      handlerUrl,
    });
    await this.ensureWidgetPlacement({
      domain: payload.domain,
      accessToken: payload.accessToken,
      handlerUrl: widgetUrl,
    });
    const state = randomBytes(32).toString('base64url');
    const cipher = new Bitrix24TokenCipher(settings.tokenEncryptionKey);
    await this.repository.saveInstallAttempt({
      stateTokenHash: hashWidgetToken(state),
      memberId: payload.memberId,
      domain: payload.domain,
      accessTokenCiphertext: cipher.encrypt(payload.accessToken),
      refreshTokenCiphertext: cipher.encrypt(payload.refreshToken),
      accessTokenExpiresAt: new Date(Date.now() + payload.expiresIn * 1000),
      applicationTokenHash: hashBitrix24ApplicationToken(payload.applicationToken),
      executorBitrixUserId: executor.id,
    });
    return { state, domain: payload.domain };
  }

  async finish(input: {
    state: string | undefined;
    body: unknown;
    requestId: string;
  }): Promise<{ status: 'active'; domain: string; executorBitrixUserId: string }> {
    const settings = this.requireEnabled();
    const auth = parseRuntimeAuth(input.body);
    this.assertPortal(auth.domain);
    await this.bitrix.verify({
      domain: auth.domain,
      accessToken: auth.accessToken,
      expectedAppCode: settings.appClientId,
    });
    const executor = await this.bitrix.currentUser({
      domain: auth.domain,
      accessToken: auth.accessToken,
    });
    if (!executor.active || !executor.admin) {
      throw new ApiError(
        403,
        'BITRIX24_INSTALL_ADMIN_REQUIRED',
        'Bitrix24 administrator must finish the application installation',
      );
    }
    if (!input.state) {
      const active = await this.repository.getActiveInstallation(auth.memberId, auth.domain);
      if (!active || active.executorBitrixUserId !== executor.id) {
        throw new ApiError(
          409,
          'BITRIX24_INSTALL_ATTEMPT_INVALID',
          'Open installation flow to activate this application',
        );
      }
      return { status: 'active', domain: auth.domain, executorBitrixUserId: executor.id };
    }
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(input.state)) throw invalidContext();
    const stateTokenHash = hashWidgetToken(input.state);
    const attempt = await this.repository.getInstallAttempt(stateTokenHash);
    if (
      !attempt ||
      attempt.memberId !== auth.memberId ||
      attempt.domain !== auth.domain ||
      attempt.executorBitrixUserId !== executor.id
    ) {
      throw new ApiError(
        409,
        'BITRIX24_INSTALL_ATTEMPT_INVALID',
        'Bitrix24 installation attempt is absent or expired',
      );
    }
    const cipher = new Bitrix24TokenCipher(settings.tokenEncryptionKey);
    await this.repository.promoteInstallAttempt({
      stateTokenHash,
      memberId: auth.memberId,
      domain: auth.domain,
      accessTokenCiphertext: cipher.encrypt(auth.accessToken),
      refreshTokenCiphertext: cipher.encrypt(auth.refreshToken),
      accessTokenExpiresAt: new Date(Date.now() + auth.expiresIn * 1000),
      applicationTokenHash: attempt.applicationTokenHash,
      executorBitrixUserId: executor.id,
      requestId: input.requestId,
    });
    return { status: 'active', domain: auth.domain, executorBitrixUserId: executor.id };
  }

  private async ensureWidgetPlacement(input: {
    domain: string;
    accessToken: string;
    handlerUrl: string;
  }): Promise<void> {
    const placements = await this.bitrix.listPlacements(input);
    const ours = placements.filter((row) =>
      text(row.placement ?? row.PLACEMENT)?.toUpperCase() === 'CRM_DEAL_DETAIL_TAB' &&
      normalizeUrl(text(row.handler ?? row.HANDLER)) === normalizeUrl(input.handlerUrl));
    if (ours.length > 1) {
      throw new ApiError(
        409,
        'BITRIX24_WIDGET_PLACEMENT_DUPLICATED',
        'More than one ERP Deal widget placement is registered',
      );
    }
    if (ours.length === 1) {
      const title = text(ours[0].title ?? ours[0].TITLE);
      if (title === 'Оплата ERP') return;
      await this.bitrix.unbindDealPaymentWidget(input);
    }
    await this.bitrix.bindDealPaymentWidget({ ...input, title: 'Оплата ERP' });
  }

  private requireEnabled(): ReturnType<CrmSyncRuntimeConfigService['getReverseSync']> & {
    appClientId: string;
    tokenEncryptionKey: string;
    publicBaseUrl: string;
  } {
    const widget = this.config.getPaymentWidget();
    const settings = this.config.getReverseSync();
    if (
      !widget.enabled || !settings.enabled || !settings.appClientId ||
      !settings.tokenEncryptionKey || !settings.publicBaseUrl
    ) {
      throw new ApiError(
        503,
        'BITRIX24_PAYMENT_WIDGET_DISABLED',
        'Bitrix24 payment widget is disabled',
      );
    }
    return settings as typeof settings & {
      appClientId: string;
      tokenEncryptionKey: string;
      publicBaseUrl: string;
    };
  }

  private assertPortal(domain: string): void {
    if (domain !== this.config.getReverseSync().portalDomain) {
      throw new ApiError(403, 'BITRIX24_PORTAL_DENIED', 'Bitrix24 portal is not allowed');
    }
  }
}

function invalidContext(): ApiError {
  return new ApiError(403, 'BITRIX24_APP_CONTEXT_INVALID', 'Bitrix24 app context is invalid');
}

function normalizeUrl(value: string | null): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

function text(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const result = String(value).trim();
  return result || null;
}

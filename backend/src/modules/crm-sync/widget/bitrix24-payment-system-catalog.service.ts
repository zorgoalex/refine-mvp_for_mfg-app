import { createHash } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import { Bitrix24LocalAppClient } from '../reverse/bitrix24-local-app-client';
import { Bitrix24OAuthTokenService } from '../reverse/bitrix24-oauth-token.service';
import { Bitrix24PaymentWidgetRepository } from './bitrix24-payment-widget.repository';

export class Bitrix24PaymentSystemCatalogService {
  private refreshPromise?: Promise<number>;

  constructor(
    private readonly repository: Bitrix24PaymentWidgetRepository,
    private readonly bitrix: Bitrix24LocalAppClient,
    private readonly tokens: Bitrix24OAuthTokenService,
    private readonly config: CrmSyncRuntimeConfigService,
  ) {}

  async refresh(audit?: { actorUserId: number; requestId: string }): Promise<number> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh(audit).finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  async refreshIfStale(): Promise<void> {
    const state = await this.repository.getPaySystemCatalogState();
    const ttlMs = this.config.getPaymentWidget().paySystemCacheTtlSeconds * 1000;
    if (
      state.count > 0 && state.lastFetchedAt &&
      state.lastFetchedAt.getTime() > Date.now() - ttlMs
    ) return;
    try {
      await this.refresh();
    } catch (error) {
      if (state.count === 0) throw error;
    }
  }

  private async doRefresh(
    audit?: { actorUserId: number; requestId: string },
  ): Promise<number> {
    const widget = this.config.getPaymentWidget();
    if (!widget.enabled) {
      throw new ApiError(
        503,
        'BITRIX24_PAYMENT_WIDGET_DISABLED',
        'Bitrix24 payment widget is disabled',
      );
    }
    const domain = this.config.getReverseSync().portalDomain;
    const token = await this.tokens.getAccessToken(domain);
    const executor = await this.bitrix.currentUser({ domain, accessToken: token });
    if (!executor.active || !executor.admin) {
      throw new ApiError(403, 'BITRIX24_EXECUTOR_INVALID', 'Bitrix24 administrator is required');
    }
    const rows = await this.bitrix.listPaySystems({ domain, accessToken: token });
    const normalized = rows.map(normalizePaySystem);
    return this.repository.replacePaySystemCatalog(normalized, audit);
  }
}

function normalizePaySystem(row: Record<string, unknown>) {
  const paySystemId = positiveInteger(row.id ?? row.ID);
  const name = text(row.name ?? row.NAME ?? row.psaName ?? row.PSA_NAME);
  if (!paySystemId || !name) {
    throw new ApiError(
      502,
      'BITRIX24_INVALID_RESPONSE',
      'Bitrix24 payment system catalog contains an invalid row',
    );
  }
  const canonical = {
    paySystemId,
    name,
    description: text(row.description ?? row.DESCRIPTION),
    xmlId: text(row.xmlId ?? row.XML_ID),
    active: flag(row.active ?? row.ACTIVE),
    isCash: flag(row.isCash ?? row.IS_CASH),
    allowEditPayment: flag(row.allowEditPayment ?? row.ALLOW_EDIT_PAYMENT),
    havePayment: flag(row.havePayment ?? row.HAVE_PAYMENT),
    entityRegistryType: text(row.entityRegistryType ?? row.ENTITY_REGISTRY_TYPE),
    personTypeId: positiveInteger(row.personTypeId ?? row.PERSON_TYPE_ID),
  };
  return {
    ...canonical,
    rawHash: createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex'),
  };
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const result = String(value).trim();
  return result || null;
}

function flag(value: unknown): boolean {
  return value === true || String(value ?? '').toUpperCase() === 'Y';
}

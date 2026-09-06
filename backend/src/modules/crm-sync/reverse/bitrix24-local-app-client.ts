import { ApiError } from '../../../common/errors/api-error';
import { BITRIX24_REVERSE_EVENTS } from './bitrix24-reverse-payload';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

interface Envelope<T> {
  result?: T;
  error?: string | number;
  error_description?: string;
}

export class Bitrix24LocalAppClient {
  constructor(
    private readonly fetchFn: FetchFn = fetch as unknown as FetchFn,
    private readonly timeoutMs = 30_000,
  ) {}

  async verifyAndBind(input: {
    domain: string;
    accessToken: string;
    handlerUrl: string;
    expectedAppCode: string;
  }): Promise<void> {
    await this.verify(input);
    await this.bindRequiredEvents(input);
  }

  async verify(input: {
    domain: string;
    accessToken: string;
    expectedAppCode: string;
  }): Promise<void> {
    const info = await this.call<{
      CODE?: unknown;
      STATUS?: unknown;
      INSTALLED?: unknown;
    }>(input.domain, input.accessToken, 'app.info', {});
    if (
      info?.CODE !== input.expectedAppCode ||
      info?.STATUS !== 'L' ||
      info?.INSTALLED !== true
    ) {
      throw new ApiError(
        403,
        'BITRIX24_APP_CONTEXT_INVALID',
        'Bitrix24 local application context was not verified',
      );
    }
  }

  async verifyPreInstall(input: {
    domain: string;
    accessToken: string;
    expectedAppCode: string;
  }): Promise<void> {
    const info = await this.call<{
      CODE?: unknown;
      STATUS?: unknown;
      INSTALLED?: unknown;
    }>(input.domain, input.accessToken, 'app.info', {});
    if (
      info?.CODE !== input.expectedAppCode ||
      info?.STATUS !== 'L' ||
      info?.INSTALLED !== false
    ) {
      throw new ApiError(
        403,
        'BITRIX24_APP_CONTEXT_INVALID',
        'Bitrix24 pre-install context was not verified',
      );
    }
  }

  async currentUser(input: {
    domain: string;
    accessToken: string;
  }): Promise<{ id: string; name: string; active: boolean; admin: boolean }> {
    const user = await this.call<Record<string, unknown>>(
      input.domain,
      input.accessToken,
      'user.current',
      {},
    );
    const id = String(user?.ID ?? user?.id ?? '');
    if (!/^[1-9][0-9]*$/.test(id)) {
      throw new ApiError(502, 'BITRIX24_INVALID_RESPONSE', 'Bitrix24 user.current returned no ID');
    }
    return {
      id,
      name: String(user?.NAME ?? user?.name ?? '').trim() || `Bitrix24 #${id}`,
      active: booleanFlag(user?.ACTIVE ?? user?.active, true),
      admin: booleanFlag(user?.ADMIN ?? user?.admin, false),
    };
  }

  async getDeal(input: {
    domain: string;
    accessToken: string;
    dealId: string;
  }): Promise<Record<string, unknown>> {
    const result = await this.call<{ item?: Record<string, unknown> }>(
      input.domain,
      input.accessToken,
      'crm.item.get',
      { entityTypeId: 2, id: Number(input.dealId) },
    );
    if (!result?.item) {
      throw new ApiError(404, 'BITRIX24_DEAL_NOT_FOUND', 'Bitrix24 Deal was not found');
    }
    return result.item;
  }

  async listDealPaymentIds(input: {
    domain: string;
    accessToken: string;
    dealId: string;
  }): Promise<string[]> {
    const all: string[] = [];
    for (let start = 0; start < 10_000; start += 50) {
      const result = await this.call<unknown>(
        input.domain,
        input.accessToken,
        'crm.item.payment.list',
        { entityId: Number(input.dealId), entityTypeId: 2, order: { id: 'asc' }, start },
      );
      const page = Array.isArray(result)
        ? result
        : isRecord(result) && Array.isArray(result.items)
          ? result.items
          : null;
      if (!page) {
        throw new ApiError(
          502,
          'BITRIX24_INVALID_RESPONSE',
          'Bitrix24 crm.item.payment.list returned an invalid response',
        );
      }
      for (const item of page) {
        if (!isRecord(item)) continue;
        const id = String(item.id ?? item.ID ?? '');
        if (/^[1-9][0-9]*$/.test(id)) all.push(id);
      }
      if (page.length < 50) break;
    }
    return [...new Set(all)];
  }

  async createDealPayment(input: {
    domain: string;
    accessToken: string;
    dealId: string;
  }): Promise<string> {
    const result = await this.call<unknown>(
      input.domain,
      input.accessToken,
      'crm.item.payment.add',
      { entityId: Number(input.dealId), entityTypeId: 2 },
    );
    const id = String(result ?? '');
    if (!/^[1-9][0-9]*$/.test(id)) {
      throw new ApiError(
        502,
        'BITRIX24_INVALID_RESPONSE',
        'Bitrix24 crm.item.payment.add returned an invalid ID',
      );
    }
    return id;
  }

  async updatePayment(input: {
    domain: string;
    accessToken: string;
    paymentId: string;
    fields: Record<string, unknown>;
  }): Promise<void> {
    await this.call(
      input.domain,
      input.accessToken,
      'sale.payment.update',
      { id: Number(input.paymentId), fields: input.fields },
    );
  }

  async getPayment(input: {
    domain: string;
    accessToken: string;
    paymentId: string;
  }): Promise<Record<string, unknown>> {
    const result = await this.call<{ payment?: Record<string, unknown> }>(
      input.domain,
      input.accessToken,
      'sale.payment.get',
      { id: Number(input.paymentId) },
    );
    if (!result?.payment) {
      throw new ApiError(502, 'BITRIX24_INVALID_RESPONSE', 'Bitrix24 payment was not returned');
    }
    return result.payment;
  }

  async listPaySystems(input: {
    domain: string;
    accessToken: string;
  }): Promise<Record<string, unknown>[]> {
    const result = await this.call<unknown>(
      input.domain,
      input.accessToken,
      'sale.paysystem.list',
      {},
    );
    const rows = Array.isArray(result)
      ? result
      : isRecord(result) && Array.isArray(result.items)
        ? result.items
        : null;
    if (!rows) {
      throw new ApiError(502, 'BITRIX24_INVALID_RESPONSE', 'Bitrix24 pay systems were not returned');
    }
    return rows.filter(isRecord);
  }

  async listPlacements(input: {
    domain: string;
    accessToken: string;
  }): Promise<Record<string, unknown>[]> {
    const result = await this.call<unknown>(
      input.domain,
      input.accessToken,
      'placement.get',
      {},
    );
    if (!Array.isArray(result)) {
      throw new ApiError(502, 'BITRIX24_INVALID_RESPONSE', 'Bitrix24 placements were not returned');
    }
    return result.filter(isRecord);
  }

  async bindDealPaymentWidget(input: {
    domain: string;
    accessToken: string;
    handlerUrl: string;
    title: string;
  }): Promise<void> {
    await this.call(input.domain, input.accessToken, 'placement.bind', {
      PLACEMENT: 'CRM_DEAL_DETAIL_TAB',
      HANDLER: input.handlerUrl,
      TITLE: input.title,
      LANG_ALL: { ru: { TITLE: input.title } },
    });
  }

  async unbindDealPaymentWidget(input: {
    domain: string;
    accessToken: string;
    handlerUrl: string;
  }): Promise<void> {
    await this.call(input.domain, input.accessToken, 'placement.unbind', {
      PLACEMENT: 'CRM_DEAL_DETAIL_TAB',
      HANDLER: input.handlerUrl,
    });
  }

  async bindRequiredEvents(input: {
    domain: string;
    accessToken: string;
    handlerUrl: string;
  }): Promise<void> {
    const existing = await this.call<unknown[]>(
      input.domain,
      input.accessToken,
      'event.get',
      {},
    );
    if (!Array.isArray(existing)) {
      throw new ApiError(
        502,
        'BITRIX24_INVALID_RESPONSE',
        'Bitrix24 event.get returned an invalid response',
      );
    }

    const bound = new Set(
      existing
        .map((row) => normalizeBinding(row))
        .filter((row): row is string => row !== null),
    );
    for (const event of BITRIX24_REVERSE_EVENTS) {
      const key = `${event}|${normalizeHandler(input.handlerUrl)}`;
      if (bound.has(key)) continue;
      await this.call(
        input.domain,
        input.accessToken,
        'event.bind',
        {
          event,
          handler: input.handlerUrl,
        },
      );
    }
  }

  private async call<T>(
    domain: string,
    accessToken: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(`https://${domain}/rest/${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ ...params, auth: accessToken }),
        signal: controller.signal,
      });
      const text = await response.text();
      let body: Envelope<T>;
      try {
        body = JSON.parse(text) as Envelope<T>;
      } catch {
        throw new ApiError(
          502,
          'BITRIX24_INVALID_RESPONSE',
          `Bitrix24 ${method} returned invalid JSON`,
        );
      }
      if (!response.ok || body.error !== undefined) {
        const code = String(body.error ?? response.status);
        throw new ApiError(
          502,
          'BITRIX24_APP_REQUEST_FAILED',
          `Bitrix24 ${method} failed: ${code}`,
        );
      }
      return body.result as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const reason = error instanceof Error && error.name === 'AbortError'
        ? 'timed out'
        : 'network failure';
      throw new ApiError(
        502,
        'BITRIX24_APP_REQUEST_FAILED',
        `Bitrix24 ${method} ${reason}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeBinding(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const event = String(row.event ?? row.EVENT ?? '').toUpperCase();
  const handler = normalizeHandler(String(row.handler ?? row.HANDLER ?? ''));
  return event && handler ? `${event}|${handler}` : null;
}

function normalizeHandler(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function booleanFlag(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toUpperCase() === 'Y' || value.toLowerCase() === 'true') return true;
    if (value.toUpperCase() === 'N' || value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { BITRIX24_ORIGINATOR_ID } from '../application/bitrix24-sync-mapper';

export type Bitrix24RequestGuard = () => Promise<void>;

export interface Bitrix24ApiPort {
  withRequestGuard<T>(
    guard: Bitrix24RequestGuard,
    operation: () => Promise<T>,
  ): Promise<T>;
  createCrmItem(entityTypeId: number, fields: Record<string, unknown>): Promise<string>;
  updateCrmItem(
    entityTypeId: number,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<void>;
  findCrmItemByOrigin(entityTypeId: number, originId: string): Promise<string | null>;
  deleteCrmItem(entityTypeId: number, id: string): Promise<void>;
  setDealProductRows(dealId: string, productRows: Array<Record<string, unknown>>): Promise<void>;
  findPaymentByXmlId(xmlId: string): Promise<string | null>;
  listDealPaymentIds(dealId: string): Promise<string[]>;
  createDealPayment(dealId: string): Promise<string>;
  updatePayment(id: string, fields: Record<string, unknown>): Promise<void>;
  deletePayment(id: string): Promise<void>;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

interface BitrixEnvelope<T> {
  result?: T;
  error?: string | number;
  error_description?: string;
}

export class Bitrix24ApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly status: number,
    description: string,
  ) {
    super(`Bitrix24 ${method} failed: ${status} ${code} ${description}`.trim());
    this.name = 'Bitrix24ApiError';
  }

  get isNotFound(): boolean {
    return (
      this.status === 404 ||
      /NOT_FOUND|ENTITY_NOT_FOUND/i.test(this.code) ||
      /not found|не найден/i.test(this.message)
    );
  }
}

/**
 * Incoming-webhook adapter. The full webhook URL is a secret and is never
 * included in logs or errors.
 */
export class Bitrix24ApiClient implements Bitrix24ApiPort {
  private readonly baseUrl: string;
  private readonly f: FetchFn;
  private readonly timeoutMs: number;
  private readonly requestGuard = new AsyncLocalStorage<Bitrix24RequestGuard>();

  constructor(webhookUrl: string, fetchFn?: FetchFn, timeoutMs = 30_000) {
    this.baseUrl = webhookUrl.replace(/\/+$/, '');
    this.f = fetchFn ?? (fetch as unknown as FetchFn);
    this.timeoutMs = timeoutMs;
  }

  withRequestGuard<T>(
    guard: Bitrix24RequestGuard,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.requestGuard.run(guard, operation);
  }

  async createCrmItem(
    entityTypeId: number,
    fields: Record<string, unknown>,
  ): Promise<string> {
    const result = await this.call<{ item?: { id?: number | string } }>('crm.item.add', {
      entityTypeId,
      fields,
    });
    const id = result?.item?.id;
    if (id === undefined || id === null) {
      throw this.unexpected('crm.item.add', result);
    }
    return String(id);
  }

  async updateCrmItem(
    entityTypeId: number,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    let updateFields = fields;
    if (Array.isArray(fields.fm)) {
      const current = await this.call<{
        item?: {
          fm?: Array<{
            id?: number | string;
            typeId?: string;
          }> | Record<string, {
            id?: number | string;
            typeId?: string;
          }>;
        };
      }>('crm.item.get', {
        entityTypeId,
        id: Number(id),
      });
      const currentValues = Array.isArray(current?.item?.fm)
        ? current.item.fm
        : Object.values(current?.item?.fm ?? {});
      const fm: Record<string, unknown> = {};
      for (const value of currentValues) {
        if (
          value.id !== undefined &&
          value.id !== null &&
          String(value.typeId).toUpperCase() === 'PHONE'
        ) {
          fm[String(value.id)] = { value: '' };
        }
      }
      fields.fm.forEach((value, index) => {
        fm[`n${index}`] = value;
      });
      updateFields = { ...fields, fm };
    }
    await this.call('crm.item.update', {
      entityTypeId,
      id: Number(id),
      fields: updateFields,
    });
  }

  async findCrmItemByOrigin(entityTypeId: number, originId: string): Promise<string | null> {
    const result = await this.call<{ items?: Array<{ id?: number | string }> }>('crm.item.list', {
      entityTypeId,
      select: ['id'],
      filter: {
        originatorId: BITRIX24_ORIGINATOR_ID,
        originId,
      },
      start: 0,
    });
    const id = result?.items?.[0]?.id;
    return id === undefined || id === null ? null : String(id);
  }

  async deleteCrmItem(entityTypeId: number, id: string): Promise<void> {
    try {
      await this.call('crm.item.delete', { entityTypeId, id: Number(id) });
    } catch (error) {
      if (error instanceof Bitrix24ApiError && error.isNotFound) return;
      throw error;
    }
  }

  async setDealProductRows(
    dealId: string,
    productRows: Array<Record<string, unknown>>,
  ): Promise<void> {
    await this.call('crm.item.productrow.set', {
      ownerType: 'D',
      ownerId: Number(dealId),
      productRows,
    });
  }

  async findPaymentByXmlId(xmlId: string): Promise<string | null> {
    const result = await this.call<{
      payments?: Array<{ id?: number | string; xmlId?: string }>;
    }>('sale.payment.list', {
      select: ['id', 'xmlId'],
      filter: { xmlId },
      order: { id: 'asc' },
      start: 0,
    });
    const id = result?.payments?.[0]?.id;
    return id === undefined || id === null ? null : String(id);
  }

  async createDealPayment(dealId: string): Promise<string> {
    const result = await this.call<number | string>('crm.item.payment.add', {
      entityId: Number(dealId),
      entityTypeId: 2,
    });
    if (typeof result !== 'number' && typeof result !== 'string') {
      throw this.unexpected('crm.item.payment.add', result);
    }
    return String(result);
  }

  async updatePayment(id: string, fields: Record<string, unknown>): Promise<void> {
    await this.call('sale.payment.update', { id: Number(id), fields });
  }

  async deletePayment(id: string): Promise<void> {
    try {
      await this.call('crm.item.payment.delete', { id: Number(id) });
    } catch (error) {
      if (error instanceof Bitrix24ApiError && error.isNotFound) return;
      throw error;
    }
  }

  private async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    // Keep the ownership proof adjacent to every external REST request.
    // requestTimeoutMs is validated to be shorter than the writer lease, so a
    // second worker cannot acquire the table lease while this request is live.
    await this.requestGuard.getStore()?.();

    let response: Response;
    try {
      response = await this.f(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Bitrix24ApiError(
        method,
        'NETWORK_ERROR',
        0,
        this.sanitizeDescription(error instanceof Error ? error.message : String(error)),
      );
    }

    const text = await response.text();
    let envelope: BitrixEnvelope<T>;
    try {
      envelope = text ? JSON.parse(text) as BitrixEnvelope<T> : {};
    } catch {
      throw new Bitrix24ApiError(
        method,
        'INVALID_JSON',
        response.status,
        this.sanitizeDescription(text.slice(0, 500)),
      );
    }

    if (!response.ok || envelope.error !== undefined) {
      throw new Bitrix24ApiError(
        method,
        String(envelope.error ?? 'HTTP_ERROR'),
        response.status,
        this.sanitizeDescription(envelope.error_description ?? text.slice(0, 500)),
      );
    }
    if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) {
      throw this.unexpected(method, envelope);
    }
    return envelope.result as T;
  }

  private unexpected(method: string, value: unknown): Bitrix24ApiError {
    return new Bitrix24ApiError(
      method,
      'UNEXPECTED_RESPONSE',
      200,
      this.sanitizeDescription(JSON.stringify(value).slice(0, 500)),
    );
  }

  async listDealPaymentIds(dealId: string): Promise<string[]> {
    const ids: string[] = [];
    for (let start = 0; ; start += 50) {
      const result = await this.call<Array<{ id?: number | string }>>(
        'crm.item.payment.list',
        {
          entityId: Number(dealId),
          entityTypeId: 2,
          order: { id: 'asc' },
          start,
        },
      );
      if (!Array.isArray(result)) throw this.unexpected('crm.item.payment.list', result);
      ids.push(
        ...result
          .map((payment) => payment.id)
          .filter((id): id is number | string => id !== undefined && id !== null)
          .map(String),
      );
      if (result.length < 50) return ids;
    }
  }

  private sanitizeDescription(value: string): string {
    return value.split(this.baseUrl).join('[redacted-webhook]');
  }
}

export class NoopBitrix24ApiClient implements Bitrix24ApiPort {
  private sequence = 1;

  constructor(private readonly log: (message: string) => void = () => {}) {}

  withRequestGuard<T>(
    _guard: Bitrix24RequestGuard,
    operation: () => Promise<T>,
  ): Promise<T> {
    return operation();
  }

  async createCrmItem(
    entityTypeId: number,
    fields: Record<string, unknown>,
  ): Promise<string> {
    this.log(`[dry-run] crm.item.add type=${entityTypeId} ${JSON.stringify(fields)}`);
    return String(this.sequence++);
  }

  async updateCrmItem(
    entityTypeId: number,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    this.log(`[dry-run] crm.item.update type=${entityTypeId} id=${id} ${JSON.stringify(fields)}`);
  }

  async findCrmItemByOrigin(_entityTypeId: number, _originId: string): Promise<string | null> {
    return null;
  }

  async deleteCrmItem(entityTypeId: number, id: string): Promise<void> {
    this.log(`[dry-run] crm.item.delete type=${entityTypeId} id=${id}`);
  }

  async setDealProductRows(
    dealId: string,
    productRows: Array<Record<string, unknown>>,
  ): Promise<void> {
    this.log(`[dry-run] crm.item.productrow.set deal=${dealId} ${JSON.stringify(productRows)}`);
  }

  async findPaymentByXmlId(_xmlId: string): Promise<string | null> {
    return null;
  }

  async listDealPaymentIds(_dealId: string): Promise<string[]> {
    return [];
  }

  async createDealPayment(dealId: string): Promise<string> {
    this.log(`[dry-run] crm.item.payment.add deal=${dealId}`);
    return String(this.sequence++);
  }

  async updatePayment(id: string, fields: Record<string, unknown>): Promise<void> {
    this.log(`[dry-run] sale.payment.update id=${id} ${JSON.stringify(fields)}`);
  }

  async deletePayment(id: string): Promise<void> {
    this.log(`[dry-run] crm.item.payment.delete id=${id}`);
  }
}

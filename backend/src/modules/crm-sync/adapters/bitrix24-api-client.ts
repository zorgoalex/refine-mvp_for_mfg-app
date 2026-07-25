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
export type Bitrix24SleepFn = (delayMs: number) => Promise<void>;

export interface Bitrix24LimitRetryEvent {
  method: string;
  code: 'QUERY_LIMIT_EXCEEDED' | 'OPERATION_TIME_LIMIT';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
}

export interface Bitrix24ApiClientOptions {
  maxRequestsPerSecond?: number;
  limitRetryMaxAttempts?: number;
  queryLimitBaseDelayMs?: number;
  operationLimitFallbackDelayMs?: number;
  now?: () => number;
  sleep?: Bitrix24SleepFn;
  onLimitRetry?: (event: Bitrix24LimitRetryEvent) => void;
}

interface BitrixTime {
  operating_reset_at?: number;
}

interface BitrixEnvelope<T> {
  result?: T;
  error?: string | number;
  error_description?: string;
  time?: BitrixTime;
}

export class Bitrix24ApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly status: number,
    description: string,
    readonly operatingResetAt: number | null = null,
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
  private readonly minimumRequestIntervalMs: number;
  private readonly limitRetryMaxAttempts: number;
  private readonly queryLimitBaseDelayMs: number;
  private readonly operationLimitFallbackDelayMs: number;
  private readonly now: () => number;
  private readonly sleep: Bitrix24SleepFn;
  private readonly onLimitRetry?: (event: Bitrix24LimitRetryEvent) => void;
  private readonly operatingResetAtByMethod = new Map<string, number>();
  private readonly operationBlockedUntilByMethod = new Map<string, number>();
  private admissionTail: Promise<void> = Promise.resolve();
  private nextAdmissionAt = 0;
  private queryBlockedUntil = 0;

  constructor(
    webhookUrl: string,
    fetchFn?: FetchFn,
    timeoutMs = 30_000,
    options: Bitrix24ApiClientOptions = {},
  ) {
    this.baseUrl = webhookUrl.replace(/\/+$/, '');
    this.f = fetchFn ?? (fetch as unknown as FetchFn);
    this.timeoutMs = timeoutMs;
    const maxRequestsPerSecond = positiveNumber(
      options.maxRequestsPerSecond ?? 2,
      'maxRequestsPerSecond',
    );
    this.minimumRequestIntervalMs = Math.ceil(1000 / maxRequestsPerSecond);
    this.limitRetryMaxAttempts = positiveInteger(
      options.limitRetryMaxAttempts ?? 11,
      'limitRetryMaxAttempts',
    );
    this.queryLimitBaseDelayMs = positiveInteger(
      options.queryLimitBaseDelayMs ?? 1000,
      'queryLimitBaseDelayMs',
    );
    this.operationLimitFallbackDelayMs = positiveInteger(
      options.operationLimitFallbackDelayMs ?? 60_000,
      'operationLimitFallbackDelayMs',
    );
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((delayMs) =>
      new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.onLimitRetry = options.onLimitRetry;
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
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.callOnce<T>(method, params);
      } catch (error) {
        if (!(error instanceof Bitrix24ApiError) || !isRetryableLimitCode(error.code)) {
          throw error;
        }

        const code = error.code.toUpperCase() as Bitrix24LimitRetryEvent['code'];
        const delayMs = code === 'QUERY_LIMIT_EXCEEDED'
          ? Math.min(this.queryLimitBaseDelayMs * 2 ** (attempt - 1), 60_000)
          : this.operationLimitDelayMs(method, error.operatingResetAt);
        this.extendLimitCooldown(method, code, delayMs);
        if (attempt >= this.limitRetryMaxAttempts) {
          throw error;
        }
        try {
          this.onLimitRetry?.({
            method,
            code,
            attempt,
            maxAttempts: this.limitRetryMaxAttempts,
            delayMs,
          });
        } catch {
          // Observability must never change delivery semantics.
        }
      }
    }
  }

  private async callOnce<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    await this.awaitAdmission(method);
    // Keep the ownership proof adjacent to every actual external REST attempt,
    // including attempts made after a limiter or retry wait.
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

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new Bitrix24ApiError(
        method,
        'RESPONSE_READ_ERROR',
        response.status,
        this.sanitizeDescription(error instanceof Error ? error.message : String(error)),
      );
    }
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

    const operatingResetAt = finiteNumberOrNull(envelope.time?.operating_reset_at);
    if (operatingResetAt !== null) {
      this.operatingResetAtByMethod.set(method, operatingResetAt);
    }

    if (!response.ok || envelope.error !== undefined) {
      throw new Bitrix24ApiError(
        method,
        String(envelope.error ?? 'HTTP_ERROR'),
        response.status,
        this.sanitizeDescription(envelope.error_description ?? text.slice(0, 500)),
        operatingResetAt ?? this.operatingResetAtByMethod.get(method) ?? null,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) {
      throw this.unexpected(method, envelope);
    }
    return envelope.result as T;
  }

  private async awaitAdmission(method: string): Promise<void> {
    for (;;) {
      const delayMs = await this.tryAdmission(method);
      if (delayMs <= 0) return;
      // Sleep outside the short queue section. A method-specific cooldown must
      // not head-of-line block unrelated Bitrix methods.
      await this.sleep(delayMs);
    }
  }

  private async tryAdmission(method: string): Promise<number> {
    let release!: () => void;
    const predecessor = this.admissionTail;
    this.admissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await predecessor;
    try {
      const blockedUntil = Math.max(
        this.nextAdmissionAt,
        this.queryBlockedUntil,
        this.operationBlockedUntilByMethod.get(method) ?? 0,
      );
      const delayMs = Math.max(0, blockedUntil - this.now());
      if (delayMs > 0) return delayMs;
      const admittedAt = this.now();
      this.nextAdmissionAt =
        Math.max(this.nextAdmissionAt, admittedAt) + this.minimumRequestIntervalMs;
      return 0;
    } finally {
      release();
    }
  }

  private operationLimitDelayMs(method: string, errorResetAt: number | null): number {
    const resetAt = errorResetAt ?? this.operatingResetAtByMethod.get(method) ?? null;
    if (resetAt !== null) {
      const untilResetMs = resetAt * 1000 - this.now();
      if (untilResetMs > 0) {
        // Cross the server's second boundary instead of retrying on its edge.
        return Math.ceil(untilResetMs) + 1000;
      }
    }
    return this.operationLimitFallbackDelayMs;
  }

  private extendLimitCooldown(
    method: string,
    code: Bitrix24LimitRetryEvent['code'],
    delayMs: number,
  ): void {
    const blockedUntil = this.now() + delayMs;
    if (code === 'QUERY_LIMIT_EXCEEDED') {
      this.queryBlockedUntil = Math.max(this.queryBlockedUntil, blockedUntil);
      return;
    }
    this.operationBlockedUntilByMethod.set(
      method,
      Math.max(
        this.operationBlockedUntilByMethod.get(method) ?? 0,
        blockedUntil,
      ),
    );
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

function isRetryableLimitCode(code: string): boolean {
  const normalized = code.toUpperCase();
  return normalized === 'QUERY_LIMIT_EXCEEDED' || normalized === 'OPERATION_TIME_LIMIT';
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive integer`);
  }
  return value;
}

function positiveNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive number`);
  }
  return value;
}

function finiteNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

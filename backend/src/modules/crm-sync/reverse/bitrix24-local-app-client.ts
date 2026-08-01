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

import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { FreecutClient } from './freecut-client';

const request = {
  units: 'mm' as const,
  params: {
    kerf_mm: 2,
    spacing_mm: 1,
    trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
    objective: 'min_waste' as const,
    include_svg: false,
  },
  stock: [{ id: 'smt-9', width_mm: 2800, height_mm: 2070, qty: 0 }],
  items: [
    { id: 'det-1', width_mm: 600, height_mm: 400, qty: 1, rotation: 'allow_90' as const, pattern_direction: 'none' as const },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(fetchImpl: typeof fetch) {
  return new FreecutClient({ baseUrl: 'http://freecut:8088', timeoutMs: 5000, fetchImpl });
}

describe('FreecutClient', () => {
  it('POSTs to {baseUrl}/v1/optimize and returns the parsed solution', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { status: 'ok', solutions: [], unplaced_items: [] }),
    ) as unknown as typeof fetch;

    const result = await client(fetchImpl).optimize(request);

    expect(result.status).toBe('ok');
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://freecut:8088/v1/optimize');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ units: 'mm' });
  });

  it('maps 422 CONSTRAINT_ERROR to a non-retryable client error carrying the reason', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(422, { status: 'error', error_code: 'CONSTRAINT_ERROR', message: 'too many instances' }),
    ) as unknown as typeof fetch;

    await expect(client(fetchImpl).optimize(request)).rejects.toMatchObject({
      statusCode: 422,
      code: 'FREECUT_CONSTRAINT_ERROR',
    });
  });

  it('maps 413 to a request-too-large error', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(413, { status: 'error', error_code: 'CONSTRAINT_ERROR', message: 'body too large' }),
    ) as unknown as typeof fetch;
    await expect(client(fetchImpl).optimize(request)).rejects.toMatchObject({ statusCode: 413 });
  });

  it('maps 429 OVERLOADED to a retryable 503', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, { status: 'error', error_code: 'OVERLOADED', message: 'busy' }),
    ) as unknown as typeof fetch;
    await expect(client(fetchImpl).optimize(request)).rejects.toMatchObject({
      statusCode: 503,
      code: 'FREECUT_OVERLOADED',
    });
  });

  it('maps an aborted (timed-out) request to a 504', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;

    await expect(client(fetchImpl).optimize(request)).rejects.toMatchObject({
      statusCode: 504,
      code: 'FREECUT_TIMEOUT',
    });
  });

  it('throws ApiError for any thrown error type', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(client(fetchImpl).optimize(request)).rejects.toBeInstanceOf(ApiError);
  });
});

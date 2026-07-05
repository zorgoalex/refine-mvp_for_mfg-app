import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { HttpOcrClient, UnavailableOcrClient, createOcrClientFromEnv, type OcrFetchFn } from './http-ocr-client';

// Minimal Response-like mock factory (pattern from twenty-api-client.test.ts).
function makeResponse(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe('HttpOcrClient', () => {
  const BASE = 'http://ocr-service:8080';
  const image = Buffer.from([1, 2, 3]);

  it('recognize() posts image bytes and parses {lines,durationMs}, dropping boxes', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeResponse(true, 200, {
        lines: [
          { text: 'ЗАКАЗ-1', score: 0.98, box: [0, 0, 10, 10] },
          { text: 'Деталь 2', score: 0.75, box: [0, 10, 10, 20] },
        ],
        durationMs: 42,
      }),
    );
    const client = new HttpOcrClient(BASE, { fetchFn: mockFetch });

    const result = await client.recognize(image, 'image/jpeg');

    expect(result).toEqual({
      lines: [
        { text: 'ЗАКАЗ-1', score: 0.98 },
        { text: 'Деталь 2', score: 0.75 },
      ],
      durationMs: 42,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE}/ocr`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: image,
      }),
    );
    // signal must be present (timeout wiring), even though this mock ignores it.
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('429 → ApiError(503, OCR_SERVICE_BUSY)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(false, 429, 'busy'));
    const client = new HttpOcrClient(BASE, { fetchFn: mockFetch });

    await expect(client.recognize(image, 'image/jpeg')).rejects.toMatchObject({
      statusCode: 503,
      code: 'OCR_SERVICE_BUSY',
    });
  });

  it('400 unreadable image → ApiError(422, OCR_IMAGE_UNREADABLE), not collapsed into 503', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(false, 400, { detail: 'unreadable image' }));
    const client = new HttpOcrClient(BASE, { fetchFn: mockFetch });

    await expect(client.recognize(image, 'image/jpeg')).rejects.toMatchObject({
      statusCode: 422,
      code: 'OCR_IMAGE_UNREADABLE',
    });
  });

  it('400 image dimensions too large → same ApiError(422, OCR_IMAGE_UNREADABLE) code', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeResponse(false, 400, { detail: 'image dimensions too large' }),
    );
    const client = new HttpOcrClient(BASE, { fetchFn: mockFetch });

    await expect(client.recognize(image, 'image/jpeg')).rejects.toMatchObject({
      statusCode: 422,
      code: 'OCR_IMAGE_UNREADABLE',
    });
  });

  it('500 → ApiError(503, OCR_SERVICE_UNAVAILABLE)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(false, 500, 'boom'));
    const client = new HttpOcrClient(BASE, { fetchFn: mockFetch });

    await expect(client.recognize(image, 'image/jpeg')).rejects.toMatchObject({
      statusCode: 503,
      code: 'OCR_SERVICE_UNAVAILABLE',
    });
  });

  it('network error → ApiError(503, OCR_SERVICE_UNAVAILABLE)', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const client = new HttpOcrClient(BASE, { fetchFn: mockFetch });

    await expect(client.recognize(image, 'image/jpeg')).rejects.toMatchObject({
      statusCode: 503,
      code: 'OCR_SERVICE_UNAVAILABLE',
    });
  });

  it('2xx with JSON body `null` → ApiError(503, OCR_SERVICE_UNAVAILABLE), not a raw TypeError', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(true, 200, null));
    const client = new HttpOcrClient(BASE, { fetchFn: mockFetch });

    await expect(client.recognize(image, 'image/jpeg')).rejects.toMatchObject({
      statusCode: 503,
      code: 'OCR_SERVICE_UNAVAILABLE',
    });
  });

  it('2xx with non-array lines ({lines:"oops"}) → ApiError(503, OCR_SERVICE_UNAVAILABLE), not .map TypeError', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse(true, 200, { lines: 'oops', durationMs: 1 }));
    const client = new HttpOcrClient(BASE, { fetchFn: mockFetch });

    await expect(client.recognize(image, 'image/jpeg')).rejects.toMatchObject({
      statusCode: 503,
      code: 'OCR_SERVICE_UNAVAILABLE',
    });
  });

  it('timeout (real AbortSignal.timeout wiring via injected short timeoutMs) → ApiError(503, OCR_SERVICE_UNAVAILABLE)', async () => {
    // Fetch mock that never resolves on its own, but honors the abort signal exactly
    // like a real fetch would — this exercises the client's actual timeout wiring
    // (AbortSignal.timeout(timeoutMs)) rather than merely mocking the rejection away.
    const hangingFetch: OcrFetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'TimeoutError'));
        });
      });
    const client = new HttpOcrClient(BASE, { fetchFn: hangingFetch, timeoutMs: 5 });

    await expect(client.recognize(image, 'image/jpeg')).rejects.toMatchObject({
      statusCode: 503,
      code: 'OCR_SERVICE_UNAVAILABLE',
    });
  });
});

describe('UnavailableOcrClient', () => {
  it('recognize() immediately throws ApiError(503, OCR_SERVICE_UNAVAILABLE)', async () => {
    const client = new UnavailableOcrClient();
    await expect(client.recognize(Buffer.from([]), 'image/jpeg')).rejects.toMatchObject({
      statusCode: 503,
      code: 'OCR_SERVICE_UNAVAILABLE',
    });
    await expect(client.recognize(Buffer.from([]), 'image/jpeg')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('createOcrClientFromEnv', () => {
  it('returns HttpOcrClient when baseUrl is configured', () => {
    expect(createOcrClientFromEnv('http://ocr-service:8080')).toBeInstanceOf(HttpOcrClient);
  });

  it('returns UnavailableOcrClient when baseUrl is undefined/empty', () => {
    expect(createOcrClientFromEnv(undefined)).toBeInstanceOf(UnavailableOcrClient);
    expect(createOcrClientFromEnv('')).toBeInstanceOf(UnavailableOcrClient);
  });
});

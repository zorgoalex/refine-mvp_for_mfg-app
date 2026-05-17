import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportApi, normalizeExportOrderRequest } from './exportApi';
import { legacyApiRoutes } from './legacyApiRoutes';

describe('exportApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('exports order to Google Drive endpoint with minimal backend payload', async () => {
    const fetchMock = mockFetch({
      success: true,
      fileName: 'order_42.xlsx',
      folder: null,
      xlsxUrl: 'https://example.test/order_42.xlsx',
    });

    await expect(exportApi.exportOrderToGoogleDrive(42)).resolves.toMatchObject({
      success: true,
      fileName: 'order_42.xlsx',
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/orders/42/export/google-drive',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    expect(init?.body).toBe(JSON.stringify({ format: 'xlsx' }));
    expect(init?.body).not.toContain('items');
    expect(init?.body).not.toContain('payments');
    expect(init?.body).not.toContain('clientPhone');
  });

  it('normalizes optional fileName and validates order id before fetch', async () => {
    const fetchMock = mockFetch({ success: true, fileName: 'custom.xlsx' });

    await exportApi.exportOrderToGoogleDrive(42, {
      format: 'xlsx',
      fileName: ' custom.xlsx ',
    });

    expect(fetchMock.mock.calls[0][1]?.body).toBe(
      JSON.stringify({ format: 'xlsx', fileName: 'custom.xlsx' }),
    );
    expect(() => exportApi.exportOrderToGoogleDrive(0)).toThrow('Invalid orderId');
  });

  it('propagates backend export failure without calling legacy export endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'EXPORT_PROVIDER_TIMEOUT',
            message: 'Provider timeout',
            requestId: 'req-export-timeout',
          },
        }),
        {
          status: 504,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(exportApi.exportOrderToGoogleDrive(42)).rejects.toMatchObject({
      code: 'EXPORT_PROVIDER_TIMEOUT',
      requestId: 'req-export-timeout',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/orders/42/export/google-drive');
    expect(fetchMock.mock.calls[0][0]).not.toBe(legacyApiRoutes.orderExport.toDrive);
  });

  it('normalizes default export request', () => {
    expect(normalizeExportOrderRequest(undefined)).toEqual({ format: 'xlsx' });
    expect(normalizeExportOrderRequest({ format: 'xlsx', fileName: ' ' })).toEqual({
      format: 'xlsx',
    });
  });
});

function mockFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

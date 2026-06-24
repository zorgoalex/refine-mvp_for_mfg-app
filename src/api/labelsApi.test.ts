import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from './authSession';
import { labelsApi } from './labelsApi';

describe('labelsApi', () => {
  beforeEach(() => {
    authSession.setAccessToken('token-1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
  });

  it('sends auth JSON requests to label endpoints', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ labelTemplateId: 1 }), { headers: { 'Content-Type': 'application/json' } }),
    );

    await labelsApi.createTemplate({
      name: 'Default',
      canvasWidthMm: 84,
      canvasHeightMm: 55,
      dpi: 203,
      defaultExportFormats: ['bmp'],
      customFieldSchema: {},
      elements: [],
      idempotencyKey: 'template-create-1',
    });

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/label-templates',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.any(Headers),
      }),
    );
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer token-1');
    expect(init.body).toContain('template-create-1');
  });

  it('downloads generation ZIP blobs', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(new Blob(['zip']), {
        headers: { 'Content-Disposition': 'attachment; filename=\"labels.zip\"' },
      }),
    );

    const result = await labelsApi.downloadGeneration(42, 7);

    expect(fetch).toHaveBeenCalledWith('/api/v1/orders/42/labels/generations/7/export', expect.any(Object));
    expect(result.fileName).toBe('labels.zip');
    expect(result.blob).toBeInstanceOf(Blob);
  });

  it('loads latest label preview through the read endpoint', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ generationId: 7, orderId: 42, svgPages: ['<svg />'] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await labelsApi.getLatest(42);

    expect(fetch).toHaveBeenCalledWith('/api/v1/orders/42/labels/latest', expect.any(Object));
    expect(result.svgPages).toEqual(['<svg />']);
  });

  it('propagates backend API errors', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'PERMISSION_DENIED', message: 'no', requestId: 'req-1' } }), {
        status: 403,
        statusText: 'Forbidden',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(labelsApi.listFields()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

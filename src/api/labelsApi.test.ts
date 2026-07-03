import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRoutes } from './apiRoutes';
import { authSession } from './authSession';
import { httpClient } from './httpClient';
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

  it('supports orderless detail label preview/generate/export endpoints', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ previewToken: 'detail-preview-token', svgPages: [] }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ generationId: 9 }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Blob(['zip']), {
          headers: { 'Content-Disposition': 'attachment; filename=\"detail-labels.zip\"' },
        }),
      );

    await labelsApi.previewDetailLabels({ templateId: 1, templateVersion: 2, detailIds: [101, 202] });
    await labelsApi.generateDetailLabels({
      templateId: 1,
      templateVersion: 2,
      detailIds: [101, 202],
      previewToken: 'detail-preview-token',
      exportFormats: ['bmp'],
      idempotencyKey: 'detail-generate-1',
    });
    const downloaded = await labelsApi.downloadDetailGeneration(9);

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/v1/labels/preview', expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/v1/labels/generate', expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/v1/labels/generations/9/export', expect.any(Object));
    expect(downloaded.fileName).toBe('detail-labels.zip');
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

  it('listQrTemplates GETs the qr-templates route', async () => {
    const get = vi.spyOn(httpClient, 'get').mockResolvedValue([]);
    await labelsApi.listQrTemplates();
    expect(get).toHaveBeenCalledWith(apiRoutes.labels.qrTemplates);
  });

  it('createQrTemplate POSTs input', async () => {
    const post = vi.spyOn(httpClient, 'post').mockResolvedValue({});
    const input = { name: 'Деталь', contentTemplate: '{bazis.detail_id}', errorCorrection: 'M', defaultSizeMm: 20, idempotencyKey: 'qr-key-123456' };
    await labelsApi.createQrTemplate(input as any);
    expect(post).toHaveBeenCalledWith(apiRoutes.labels.qrTemplates, input);
  });

  it('deleteQrTemplate DELETEs with version + key body', async () => {
    const del = vi.spyOn(httpClient, 'delete').mockResolvedValue(undefined);
    await labelsApi.deleteQrTemplate(5, 2, 'qr-key-123456');
    expect(del).toHaveBeenCalledWith(apiRoutes.labels.qrTemplate(5), { body: JSON.stringify({ version: 2, idempotencyKey: 'qr-key-123456' }) });
  });
});

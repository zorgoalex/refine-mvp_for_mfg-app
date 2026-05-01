import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from './authSession';
import { normalizeVlmAnalyzeRequest, vlmApi } from './vlmApi';

describe('vlmApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
    authSession.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    authSession.clear();
  });

  it('checks backend VLM health via httpClient', async () => {
    const fetchMock = mockFetch({ status: 'ok', detailsVisible: true });

    await expect(vlmApi.health()).resolves.toEqual({ status: 'ok', detailsVisible: true });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/vlm/health',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('uploads file as FormData without manual Content-Type or localStorage token handling', async () => {
    authSession.setAccessToken('access-token');
    const fetchMock = mockFetch({
      success: true,
      uploadId: 'upl_1',
      url: 'https://files.example/upl_1.png',
      key: 'upl_1.png',
      size: 12,
      contentType: 'image/png',
    });
    const file = new Blob(['image'], { type: 'image/png' });

    await vlmApi.upload(file, 'order_file');

    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Headers;
    expect(fetchMock.mock.calls[0][0]).toBe('/api/vlm/upload');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    expect(headers.get('Content-Type')).toBeNull();
    expect(headers.get('Authorization')).toBe('Bearer access-token');
  });

  it('analyzes uploaded image with camelCase backend contract', async () => {
    const fetchMock = mockFetch({
      success: true,
      uploadId: 'upl_1',
      result: { items: [] },
    });

    await vlmApi.analyze({
      uploadId: ' upl_1 ',
      provider: ' openai ',
      model: ' gpt-4.1-mini ',
      providerOrder: [' openai ', ' '],
      promptKv: { namespace: 'orders', name: 'import', lang: 'ru' },
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(fetchMock.mock.calls[0][0]).toBe('/api/vlm/analyze');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(
      JSON.stringify({
        uploadId: 'upl_1',
        provider: 'openai',
        model: 'gpt-4.1-mini',
        providerOrder: ['openai'],
        promptKv: { namespace: 'orders', name: 'import', lang: 'ru' },
      }),
    );
    expect(init?.body).not.toContain('image_url');
    expect(init?.body).not.toContain('provider_order');
  });

  it('normalizes blank optional analyze values', () => {
    expect(
      normalizeVlmAnalyzeRequest({
        uploadId: ' ',
        imageUrl: undefined,
        providerOrder: [' openai ', ''],
      }),
    ).toEqual({
      uploadId: null,
      imageUrl: undefined,
      providerOrder: ['openai'],
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

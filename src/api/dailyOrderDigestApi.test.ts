import { afterEach, describe, expect, it, vi } from 'vitest';
import { dailyOrderDigestApi } from './dailyOrderDigestApi';

describe('dailyOrderDigestApi wire contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('uses protected daily digest routes and omits fixed timezone from settings writes', async () => {
    vi.stubEnv('VITE_API_URL', '');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'GET' && String(_input).endsWith('/image')) {
        return new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await dailyOrderDigestApi.settings();
    await dailyOrderDigestApi.saveSettings({
      version: 3,
      enabled: false,
      groupChatId: '123456789@g.us',
      sendTime: '08:45',
      catchUpPolicy: 'until_deadline',
      catchUpDeadline: '10:00',
      cardsPerMessage: 1,
      partialPolicy: 'repeat_all',
      duplicateRiskConfirmed: true,
    });
    await dailyOrderDigestApi.preview();
    await dailyOrderDigestApi.send({
      settingsVersion: 3,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      confirmed: true,
    });
    await dailyOrderDigestApi.runs();
    await dailyOrderDigestApi.run('run/1');
    await dailyOrderDigestApi.pageImage('run/1', 2);
    await dailyOrderDigestApi.retry('run/1', {
      mode: 'remaining',
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      duplicateRiskConfirmed: true,
    });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/v1/whatsapp/daily-digest/settings',
      '/api/v1/whatsapp/daily-digest/settings',
      '/api/v1/whatsapp/daily-digest/preview',
      '/api/v1/whatsapp/daily-digest/runs',
      '/api/v1/whatsapp/daily-digest/runs',
      '/api/v1/whatsapp/daily-digest/runs/run%2F1',
      '/api/v1/whatsapp/daily-digest/runs/run%2F1/pages/2/image',
      '/api/v1/whatsapp/daily-digest/runs/run%2F1/retry',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({
      version: 3,
      enabled: false,
      groupChatId: '123456789@g.us',
      sendTime: '08:45',
      catchUpPolicy: 'until_deadline',
      catchUpDeadline: '10:00',
      cardsPerMessage: 1,
      partialPolicy: 'repeat_all',
      duplicateRiskConfirmed: true,
    });
    expect(fetchMock.mock.calls[1][1]?.method).toBe('PUT');
    expect(fetchMock.mock.calls[2][1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[3][1]?.body).toContain('11111111-1111-4111-8111-111111111111');
    expect(fetchMock.mock.calls[7][1]?.body).toContain('22222222-2222-4222-8222-222222222222');
  });
});

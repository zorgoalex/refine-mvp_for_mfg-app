import { afterEach, describe, expect, it, vi } from 'vitest';
import { broadcastsApi } from './broadcastsApi';

const input = {
  name: 'Утро', enabled: false, groupChatId: '123456789@g.us', weekdays: [1, 2, 3, 4, 5],
  sendTime: '08:45', sendWindowMinutes: 30, catchUpPolicy: 'until_deadline' as const, catchUpDeadline: '10:00',
  partialPolicy: 'remaining' as const, orderDateOffsetDays: 1, cardsPerMessage: 2 as const,
  captionTemplate: 'Заказы на {target_date}', duplicateRiskConfirmed: true,
};

describe('broadcastsApi wire contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('uses the broadcast routes with the documented methods and bodies', async () => {
    vi.stubEnv('VITE_API_URL', '');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/image')) return new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await broadcastsApi.list();
    await broadcastsApi.create(input);
    await broadcastsApi.control();
    await broadcastsApi.setControl({ version: 2, paused: true });
    await broadcastsApi.catalog();
    await broadcastsApi.legacyDigestRuns();
    await broadcastsApi.get(7);
    await broadcastsApi.update(7, { ...input, version: 4 });
    await broadcastsApi.archive(7, { version: 4 });
    await broadcastsApi.preview(7);
    await broadcastsApi.send(7, { settingsVersion: 4, idempotencyKey: 'k1', confirmed: true });
    await broadcastsApi.runs(7);
    await broadcastsApi.replanToday(7, { version: 4, idempotencyKey: 'k2' });
    await broadcastsApi.run('run/1');
    await broadcastsApi.messageImage('run/1', 2);
    await broadcastsApi.retry('run/1', { mode: 'all', idempotencyKey: 'k3', duplicateRiskConfirmed: true });

    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>;
    const base = '/api/v1/whatsapp';
    expect(calls.map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual([
      `GET ${base}/broadcasts`,
      `POST ${base}/broadcasts`,
      `GET ${base}/broadcasts/control`,
      `POST ${base}/broadcasts/control`,
      `GET ${base}/broadcasts/catalog`,
      `GET ${base}/broadcasts/legacy-digest-runs`,
      `GET ${base}/broadcasts/7`,
      `PATCH ${base}/broadcasts/7`,
      `POST ${base}/broadcasts/7/archive`,
      `POST ${base}/broadcasts/7/preview`,
      `POST ${base}/broadcasts/7/runs`,
      `GET ${base}/broadcasts/7/runs`,
      `POST ${base}/broadcasts/7/schedule/today/replan`,
      `GET ${base}/broadcast-runs/run%2F1`,
      `GET ${base}/broadcast-runs/run%2F1/messages/2/image`,
      `POST ${base}/broadcast-runs/run%2F1/retry`,
    ]);
    const body = (index: number) => JSON.parse(calls[index][1]?.body as string);
    expect(body(1)).not.toHaveProperty('version');
    expect(body(3)).toEqual({ version: 2, paused: true });
    expect(body(7)).toEqual({ ...input, version: 4 });
    expect(body(8)).toEqual({ version: 4 });
    expect(body(10)).toEqual({ settingsVersion: 4, idempotencyKey: 'k1', confirmed: true });
    expect(body(12)).toEqual({ version: 4, idempotencyKey: 'k2' });
    expect(body(15)).toEqual({ mode: 'all', idempotencyKey: 'k3', duplicateRiskConfirmed: true });
  });

  it('never touches the legacy daily-digest routes', async () => {
    vi.stubEnv('VITE_API_URL', '');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await broadcastsApi.list();
    await broadcastsApi.legacyDigestRuns();
    for (const [url] of fetchMock.mock.calls as unknown as Array<[RequestInfo | URL]>) {
      expect(String(url)).not.toContain('daily-digest/');
    }
  });
});

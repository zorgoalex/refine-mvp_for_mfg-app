import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusAutomationApi } from './statusAutomationApi';

describe('statusAutomationApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('calls the status automation CRUD and event type endpoints', async () => {
    const fetchMock = mockFetch(
      [],
      { id: 7 },
      { id: 7 },
      { deleted: true },
      [],
    );
    const update = { name: 'Updated', version: 3 };

    await statusAutomationApi.list();
    await statusAutomationApi.create({
      name: 'On payment',
      eventType: 'payment.created',
      actionType: 'change_order_status',
      targetStatusId: 4,
    });
    await statusAutomationApi.update(7, update);
    await statusAutomationApi.remove(7);
    await statusAutomationApi.listEventTypes();

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/status-automation/rules');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/status-automation/rules');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/status-automation/rules/7');
    expect(fetchMock.mock.calls[2][1]).toEqual(
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify(update),
      }),
    );
    expect(fetchMock.mock.calls[3][0]).toBe('/api/v1/status-automation/rules/7');
    expect(fetchMock.mock.calls[3][1]?.method).toBe('DELETE');
    expect(fetchMock.mock.calls[4][0]).toBe('/api/v1/status-automation/event-types');
    expect(fetchMock.mock.calls[4][1]?.method).toBe('GET');
  });
});

function mockFetch(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

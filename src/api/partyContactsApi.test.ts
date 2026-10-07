import { afterEach, describe, expect, it, vi } from 'vitest';
import { partyContactsApi } from './partyContactsApi';

describe('partyContactsApi wire contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('uses the documented routes, methods and bodies', async () => {
    vi.stubEnv('VITE_API_URL', '');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const body = { version: 2, contacts: [{ contactId: null, kind: 'email' as const, value: 'a@b.kz', isPrimary: true, note: null }] };

    await partyContactsApi.get('supplier', 5);
    await partyContactsApi.replace('vendor', 6, body);
    await partyContactsApi.get('client', 7);
    await partyContactsApi.list('supplier', [1, 2]);
    await partyContactsApi.list('vendor', [3]);
    await partyContactsApi.supplierCounterparties(' ооо альфа ');
    await partyContactsApi.supplierCounterparties();
    await partyContactsApi.supplierCounterparty(5);
    await partyContactsApi.setSupplierCounterparty(5, { refKey1c: null, expectedRefKey1c: 'k' });
    await partyContactsApi.supplierFromCounterparty('k');
    await partyContactsApi.clientCounterparty(7);
    await partyContactsApi.clientCounterpartyCandidates(7);
    await partyContactsApi.clientCounterpartyCandidates(7, ' 8 701 ');
    await partyContactsApi.setClientCounterparty(7, { refKey1c: 'k', expectedRefKey1c: null });

    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>;
    expect(calls.map(([url, init]) => `${init?.method} ${decodeURIComponent(String(url))}`)).toEqual([
      'GET /api/v1/suppliers/5/contacts',
      'PUT /api/v1/vendors/6/contacts',
      'GET /api/v1/clients/7/contacts',
      'GET /api/v1/supplier-contacts?ids=1,2',
      'GET /api/v1/vendor-contacts?ids=3',
      'GET /api/v1/supplier-counterparties?search=ооо альфа',
      'GET /api/v1/supplier-counterparties',
      'GET /api/v1/suppliers/5/counterparty',
      'PUT /api/v1/suppliers/5/counterparty',
      'POST /api/v1/suppliers/from-counterparty',
      'GET /api/v1/clients/7/counterparty',
      'GET /api/v1/clients/7/counterparty-candidates',
      'GET /api/v1/clients/7/counterparty-candidates?search=8 701',
      'PUT /api/v1/clients/7/counterparty',
    ]);
    expect(JSON.parse(calls[1][1]?.body as string)).toEqual(body);
    expect(JSON.parse(calls[8][1]?.body as string)).toEqual({ refKey1c: null, expectedRefKey1c: 'k' });
    expect(JSON.parse(calls[9][1]?.body as string)).toEqual({ refKey1c: 'k' });
    expect(JSON.parse(calls[13][1]?.body as string)).toEqual({ refKey1c: 'k', expectedRefKey1c: null });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bazisCutApi,
  buildBazisCutSetListUrl,
  type BazisCutDetailFields,
  type BazisCutSetCardDto,
} from './bazisCutApi';

describe('bazisCutApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('builds the paginated remote-search list URL', () => {
    expect(buildBazisCutSetListUrl({ search: '  МП-1491  ', page: 2, pageSize: 25 })).toBe(
      '/api/v1/bazis-cut-sets?search=%D0%9C%D0%9F-1491&page=2&pageSize=25',
    );
    expect(buildBazisCutSetListUrl()).toBe('/api/v1/bazis-cut-sets');
  });

  it('drives all eight routes and puts idempotency keys in command headers', async () => {
    const card = cardDto();
    const list = {
      items: [card],
      page: 1,
      pageSize: 20,
      total: 1,
    };
    const fetchMock = mockFetch(
      jsonResponse(list),
      jsonResponse({ set: card, addedCount: 1 }),
      jsonResponse(card),
      jsonResponse({ set: { ...card, name: 'Переименован' } }),
      jsonResponse({ set: card, addedCount: 0 }),
      jsonResponse({ set: card }),
      jsonResponse({ set: card }),
      new Response('OLE2', {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.ms-excel',
          'Content-Disposition': "attachment; filename*=UTF-8''%D0%91%D0%B0%D0%B7%D0%B8%D1%81-1491.xls",
        },
      }),
    );

    await bazisCutApi.list({ search: '1491', page: 1, pageSize: 20 });
    await bazisCutApi.create(
      { orderId: 9, detailIds: [101, 102] },
      { idempotencyKey: 'create-key-1491' },
    );
    await bazisCutApi.get(42);
    await bazisCutApi.rename(
      42,
      { name: 'Переименован', expectedVersion: 1 },
      { idempotencyKey: 'rename-key-1491' },
    );
    await bazisCutApi.addDetails(
      42,
      { orderId: 10, detailIds: [201], expectedVersion: 2 },
      { idempotencyKey: 'add-key-1491' },
    );
    await bazisCutApi.updateDetail(
      42,
      7,
      { ...detailFields(), expectedVersion: 3 },
      { idempotencyKey: 'update-key-1491' },
    );
    await bazisCutApi.removeDetail(
      42,
      7,
      { expectedVersion: 4 },
      { idempotencyKey: 'remove-key-1491' },
    );
    const exported = await bazisCutApi.exportXls(42);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/bazis-cut-sets?search=1491&page=1&pageSize=20',
      '/api/v1/bazis-cut-sets',
      '/api/v1/bazis-cut-sets/42',
      '/api/v1/bazis-cut-sets/42',
      '/api/v1/bazis-cut-sets/42/details',
      '/api/v1/bazis-cut-sets/42/details/7',
      '/api/v1/bazis-cut-sets/42/details/7',
      '/api/v1/bazis-cut-sets/42/export.xls',
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      'GET', 'POST', 'GET', 'PATCH', 'POST', 'PATCH', 'DELETE', 'POST',
    ]);

    const commandCalls = [1, 3, 4, 5, 6];
    const expectedKeys = [
      'create-key-1491',
      'rename-key-1491',
      'add-key-1491',
      'update-key-1491',
      'remove-key-1491',
    ];
    commandCalls.forEach((callIndex, index) => {
      const headers = new Headers(fetchMock.mock.calls[callIndex][1]?.headers);
      expect(headers.get('Idempotency-Key')).toBe(expectedKeys[index]);
      expect(headers.get('Content-Type')).toBe('application/json');
    });

    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({
      orderId: 9,
      detailIds: [101, 102],
    });
    expect(JSON.parse(fetchMock.mock.calls[6][1]?.body as string)).toEqual({ expectedVersion: 4 });
    expect(fetchMock.mock.calls[7][1]).toMatchObject({ cache: 'no-store' });
    expect(exported.fileName).toBe('Базис-1491.xls');
    expect(exported.blob.type).toBe('application/vnd.ms-excel');
  });

  it('models exactly 33 editable fields and preserves nullable priority', () => {
    const fields = detailFields();
    expect(Object.keys(fields)).toHaveLength(33);
    expect(fields.position).toBe('01.00.07');
    expect(fields.priority).toBeNull();
  });

  it('rejects invalid ids, empty detail selections, and invalid idempotency keys before fetch', async () => {
    const fetchMock = vi.mocked(fetch);

    expect(() => bazisCutApi.get(0)).toThrow('Invalid setId');
    expect(() =>
      bazisCutApi.create(
        { orderId: 9, detailIds: [] },
        { idempotencyKey: 'create-key-1491' },
      ),
    ).toThrow('Invalid detailIds');
    expect(() =>
      bazisCutApi.rename(
        42,
        { name: 'Bad', expectedVersion: 0 },
        { idempotencyKey: 'short' },
      ),
    ).toThrow('Invalid idempotencyKey');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function mockFetch(...responses: Response[]) {
  const fetchMock = vi.fn();
  responses.forEach((response) => fetchMock.mockResolvedValueOnce(response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function detailFields(): BazisCutDetailFields {
  return {
    cutEnabled: true,
    materialType: 'Площадной',
    materialName: 'ЛДСП Белый',
    materialArticle: '',
    thicknessMm: 16,
    position: '01.00.07',
    partName: 'К1_Цоколь',
    finishedLengthMm: 411,
    finishedWidthMm: 100,
    cutLengthMm: 411,
    cutWidthMm: 100,
    quantity: 2,
    orientation: 'Не задана',
    groove: '',
    l1Name: '',
    l1Designation: '',
    l1ThicknessMm: 0,
    l2Name: '',
    l2Designation: '',
    l2ThicknessMm: 0,
    w1Name: '',
    w1Designation: '',
    w1ThicknessMm: 0,
    w2Name: '',
    w2Designation: '',
    w2ThicknessMm: 0,
    priority: null,
    comment: '',
    customProperty: '',
    glue: '',
    milling: 'Модерн',
    route: 'Присадка:',
    film: 'Балхаш KZ 10',
  };
}

function cardDto(): BazisCutSetCardDto {
  return {
    bazisCutSetId: 42,
    name: '1491',
    version: 1,
    createdBy: 1,
    updatedBy: 1,
    createdAt: '2026-07-15T10:00:00.000Z',
    updatedAt: '2026-07-15T10:00:00.000Z',
    positionCount: 0,
    quantity: 0,
    orders: [],
    projects: [],
    bazisProjects: [],
    bazisOrders: [],
    details: [],
  };
}

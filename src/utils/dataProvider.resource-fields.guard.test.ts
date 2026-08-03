import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const makeFetchMock = () =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      data: {
        vendors: [],
        vendors_aggregate: { aggregate: { count: 0 } },
      },
    }),
  }));

const getLastGraphqlQuery = (fetchMock: ReturnType<typeof makeFetchMock>) => {
  const body = fetchMock.mock.calls.at(-1)?.[1]?.body;
  if (typeof body !== 'string') {
    throw new Error('Expected GraphQL fetch body');
  }
  return JSON.parse(body).query as string;
};

describe('dataProvider resource field guards', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_HASURA_GRAPHQL_URL', 'https://hasura.test/v1/graphql');
    vi.stubGlobal('localStorage', createLocalStorageMock());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('drops stale order sorters that do not exist on vendors', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const { dataProvider } = await import('./dataProvider');

    await dataProvider('').getList({
      resource: 'vendors',
      pagination: { current: 1, pageSize: 20 },
      sorters: [{ field: 'order_date', order: 'desc' }],
      filters: [],
    });

    const query = getLastGraphqlQuery(fetchMock);
    expect(query).not.toContain('order_date');
    expect(query).not.toContain('order_by');
    expect(query).toContain('is_active');
  });

  it('keeps valid vendors sorters after dropping stale sorters', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const { dataProvider } = await import('./dataProvider');

    await dataProvider('').getList({
      resource: 'vendors',
      pagination: { current: 1, pageSize: 20 },
      sorters: [
        { field: 'order_date', order: 'desc' },
        { field: 'sort_order', order: 'asc' },
        { field: 'vendor_id', order: 'asc' },
      ],
      filters: [],
    });

    const query = getLastGraphqlQuery(fetchMock);
    expect(query).not.toContain('order_date');
    expect(query).toContain('{ sort_order: asc }');
    expect(query).toContain('{ vendor_id: asc }');
  });

  it('drops stale order filters that do not exist on vendors', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const { dataProvider } = await import('./dataProvider');

    await dataProvider('').getList({
      resource: 'vendors',
      pagination: { current: 1, pageSize: 20 },
      sorters: [],
      filters: [{ field: 'order_date', operator: 'gte', value: '2026-08-01' }],
    });

    const query = getLastGraphqlQuery(fetchMock);
    expect(query).not.toContain('order_date');
    expect(query).toContain('is_active');
  });
});

function createLocalStorageMock(): Storage {
  const storage = new Map<string, string>();

  return {
    get length() {
      return storage.size;
    },
    clear: vi.fn(() => storage.clear()),
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(storage.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      storage.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, String(value));
    }),
  };
}

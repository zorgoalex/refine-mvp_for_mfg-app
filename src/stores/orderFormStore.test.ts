import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let useOrderFormStore: typeof import('./orderFormStore').useOrderFormStore;

describe('orderFormStore version sync', () => {
  beforeAll(async () => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    ({ useOrderFormStore } = await import('./orderFormStore'));
  });

  afterEach(() => {
    useOrderFormStore.getState().reset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('keeps root order version aligned when header version changes', () => {
    useOrderFormStore.getState().loadOrder({
      header: {
        order_id: 15,
        order_name: 'E2E order',
        client_id: 1,
        order_date: '2026-05-10',
        order_status_id: 1,
        payment_status_id: 1,
        version: 3,
      },
      details: [],
      payments: [],
      workshops: [],
      requirements: [],
      dowelingLinks: [],
      deletedDetails: [],
      deletedPayments: [],
      deletedWorkshops: [],
      deletedRequirements: [],
      deletedDowelingLinks: [],
      isDirty: false,
      version: 3,
    });

    useOrderFormStore.getState().updateHeaderField('version', 4);

    const state = useOrderFormStore.getState();
    expect(state.header.version).toBe(4);
    expect(state.version).toBe(4);
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

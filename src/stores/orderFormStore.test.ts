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

  it('preserves bazisNodeId on load and clears it on inserted copies', () => {
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
      details: [
        {
          detail_id: 44,
          detail_number: 1,
          bazisNodeId: 777,
          height: 500,
          width: 300,
          quantity: 2,
          area: 0.3,
          material_id: null,
          sheet_material_type_id: 5,
          milling_type_id: 1,
          edge_type_id: 1,
          detail_cost: 0,
          priority: 100,
        },
      ],
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

    const source = useOrderFormStore.getState().details[0];
    const sourceKey = source.temp_id ?? source.detail_id!;
    useOrderFormStore.getState().insertDetailAfter(sourceKey, {
      ...source,
      bazisNodeId: source.bazisNodeId,
    });

    const details = useOrderFormStore.getState().details;
    expect(details[0].bazisNodeId).toBe(777);
    expect(details[1].bazisNodeId).toBeUndefined();
  });

  it('assigns unique temp_id to every detail on bulk loadOrder without detail_id (bazis draft 214+ панелей)', () => {
    // Регрессия: Date.now()+Math.random() давал ~2048 различимых значений в
    // пределах одной мс (мантисса double) → на 214 деталях коллизия temp_id
    // почти гарантирована → дубль clientKey → 422 на create-from-draft.
    const detailCount = 300;
    useOrderFormStore.getState().loadOrder({
      header: {
        order_name: 'E2E bazis draft',
        client_id: 1,
        order_date: '2026-07-15',
        order_status_id: 1,
        payment_status_id: 1,
        version: 0,
      },
      details: Array.from({ length: detailCount }, (_, index) => ({
        detail_number: index + 1,
        bazisNodeId: 10_000 + index,
        height: 500,
        width: 300,
        quantity: 1,
        area: 0.15,
        material_id: null,
        sheet_material_type_id: 5,
        milling_type_id: 1,
        edge_type_id: 1,
        detail_cost: 0,
        priority: 100,
      })),
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
      version: 0,
    });

    const details = useOrderFormStore.getState().details;
    expect(details).toHaveLength(detailCount);
    const tempIds = details.map((detail) => detail.temp_id);
    expect(tempIds.every((tempId) => tempId != null)).toBe(true);
    expect(new Set(tempIds.map(String)).size).toBe(detailCount);
  });

  it('keeps detail_id as temp_id for persisted details on loadOrder', () => {
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
      details: [
        {
          detail_id: 44,
          detail_number: 1,
          height: 500,
          width: 300,
          quantity: 2,
          area: 0.3,
          material_id: null,
          sheet_material_type_id: 5,
          milling_type_id: 1,
          edge_type_id: 1,
          detail_cost: 0,
          priority: 100,
        },
      ],
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

    expect(useOrderFormStore.getState().details[0].temp_id).toBe(44);
  });
});

describe('orderFormStore per-order isolation', () => {
  let mod: typeof import('./orderFormStore');

  beforeAll(async () => {
    vi.stubGlobal('sessionStorage', createMemoryStorage());
    vi.stubGlobal('localStorage', createMemoryStorage());
    vi.resetModules();
    mod = await import('./orderFormStore');
  });

  afterAll(() => vi.unstubAllGlobals());

  it('keeps two order ids isolated; no cross-write', () => {
    const a = mod.getOrderDraftStore('1');
    const b = mod.getOrderDraftStore('2');
    a.getState().updateHeaderField('order_name', 'A');
    b.getState().updateHeaderField('order_name', 'B');
    expect(a.getState().header.order_name).toBe('A');
    expect(b.getState().header.order_name).toBe('B');
    expect(a.getState().isDirty).toBe(true);
  });

  it('persists each draft + dirty marker under its own sessionStorage key', () => {
    const a = mod.getOrderDraftStore('7');
    a.getState().updateHeaderField('order_name', 'persist-me');
    expect(sessionStorage.getItem('order-form-storage:7')).toContain('persist-me');
    expect(sessionStorage.getItem('order-form-storage:7')).toContain('"isDirty":true');
  });

  it('keeps PDF-import candidate ids transient and clears them after save sync', () => {
    const store = mod.getOrderDraftStore('pdf-import');
    store.getState().addPdfImportedDetail({
      detail_number: 1,
      height: 500,
      width: 300,
      quantity: 1,
      area: 0.15,
      material_id: null,
      sheet_material_type_id: 5,
      milling_type_id: 1,
      edge_type_id: 1,
      detail_cost: 0,
      priority: 100,
    });

    expect(store.getState().pdfImportCandidateTempIds).toHaveLength(1);
    expect(store.getState().getFormValues().pdfImportCandidateTempIds).toHaveLength(1);
    expect(sessionStorage.getItem('order-form-storage:pdf-import')).not.toContain(
      'pdfImportCandidateTempIds',
    );

    store.getState().syncOriginals();
    expect(store.getState().pdfImportCandidateTempIds).toEqual([]);
  });

  it('destroyOrderDraftStore removes the registry entry and its sessionStorage', () => {
    const a = mod.getOrderDraftStore('9');
    a.getState().updateHeaderField('order_name', 'gone');
    mod.destroyOrderDraftStore('9');
    expect(sessionStorage.getItem('order-form-storage:9')).toBeNull();
    // re-create is a fresh slice
    expect(mod.getOrderDraftStore('9').getState().header.order_name).toBeUndefined();
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

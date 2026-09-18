import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrderDetail } from '../types/orders';
import { mapOrderFormToSaveOrderDto } from '../api/mappers/orderMapper';

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

  it('keeps catalogue drafts in totals and clears explicit deletion tracker after save/reset', () => {
    const store = useOrderFormStore.getState();
    store.setHeader({ discount: 1, surcharge: 0 });
    store.setCatalogLines([{ id: 7, catalogItemId: 8, name: 'E2E-service', kind: 'service', sku: null, unitId: 1,
      unitName: 'шт', refKey1c: null, quantity: '2', unitPrice: '1500.50', catalogActive: true }]);
    expect(useOrderFormStore.getState().header.final_amount).toBe(3000);
    expect(store.calculatedTotals()).toMatchObject({ total_amount: 3001, parts_count: 0, total_area: 0 });
    expect(store.getFormValues().catalogLines).toHaveLength(1);
    store.setCatalogLines([], [7]);
    expect(useOrderFormStore.getState().deletedCatalogLineIds).toEqual([7]);
    store.syncOriginals();
    expect(useOrderFormStore.getState().deletedCatalogLineIds).toEqual([]);
    store.reset();
    expect(useOrderFormStore.getState().catalogLines).toEqual([]);
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

  it('pads the grid to 20 UI rows without dirtying totals', () => {
    const state = useOrderFormStore.getState();
    state.ensureMinimumDetailRows(20, {
      detail_number: 0,
      height: 0,
      width: 0,
      quantity: 0,
      area: 0,
      material_id: null,
      milling_type_id: 1,
      edge_type_id: 1,
      priority: 100,
    });

    const padded = useOrderFormStore.getState();
    expect(padded.details).toHaveLength(20);
    expect(padded.details.every((row) => row.is_placeholder === true)).toBe(true);
    expect(padded.isDirty).toBe(false);
    expect(padded.calculatedTotals()).toMatchObject({
      positions_count: 0,
      parts_count: 0,
      total_area: 0,
      total_amount: 0,
    });
  });

  const emptyDetail: Omit<OrderDetail, 'temp_id'> = {
    detail_number: 0, height: 0, width: 0, quantity: 0, area: 0, material_id: null,
    milling_type_id: 1, edge_type_id: 1, priority: 100,
  };
  const pdfDetail: Omit<OrderDetail, 'temp_id'> = {
    ...emptyDetail, height: 500, width: 300, quantity: 2, area: 0.3,
    sheet_material_type_id: 5, detail_cost: 100, basis_project: 'E2E-project',
    basis_product: 'E2E-product', basis_designation: 'E2E-panel', doweling: true,
  };

  it.each(['addDetail', 'addPdfImportedDetail'] as const)(
    '%s owns numbering for unnumbered imported input and ignores a supplied number',
    (action) => {
      const store = useOrderFormStore.getState();
      store.setHeader({ order_name: 'E2E unnumbered import', client_id: 1,
        order_date: '2026-09-17', order_status_id: 1 });
      const { detail_number: ignoredNumber, ...input } = pdfDetail;
      expect(ignoredNumber).toBe(0);
      store[action](input);
      store[action]({ ...input, detail_number: 999 });
      const state = useOrderFormStore.getState();
      expect(state.details.map(row => row.detail_number)).toEqual([1, 2]);
      expect(new Set(state.details.map(row => row.temp_id)).size).toBe(2);
      expect(state.details.every(row => row.delete_flag === false)).toBe(true);
      expect(state.calculatedTotals()).toMatchObject({
        positions_count: 2, parts_count: 4, total_amount: 200,
      });
      expect(state.calculatedTotals().total_area).toBeCloseTo(0.6);
      const dto = mapOrderFormToSaveOrderDto(state.getFormValues());
      expect(dto.details.map(row => row.detailNumber)).toEqual([1, 2]);
    },
  );

  it('appends an unnumbered detail after the highest existing number without mutating existing rows', () => {
    const store = useOrderFormStore.getState();
    store.addDetail(pdfDetail);
    const first = { ...useOrderFormStore.getState().details[0], detail_number: 7 };
    useOrderFormStore.setState({ details: [first] });
    const { detail_number: ignoredNumber, ...input } = pdfDetail;
    expect(ignoredNumber).toBe(0);
    store.addDetail(input);
    expect(useOrderFormStore.getState().details[0]).toBe(first);
    expect(useOrderFormStore.getState().details.map(row => row.detail_number)).toEqual([7, 8]);
  });

  it('fills a PDF placeholder with unnumbered input before appending', () => {
    const store = useOrderFormStore.getState();
    store.ensureMinimumDetailRows(1, emptyDetail);
    const slot = useOrderFormStore.getState().details[0];
    const { detail_number: ignoredNumber, ...input } = pdfDetail;
    expect(ignoredNumber).toBe(0);
    store.addPdfImportedDetail(input);
    store.addPdfImportedDetail(input);
    const state = useOrderFormStore.getState();
    expect(state.details.map(row => row.detail_number)).toEqual([1, 2]);
    expect(state.details[0].temp_id).toBe(slot.temp_id);
    expect(state.details.every(row => row.is_placeholder === false)).toBe(true);
    expect(state.pdfImportCandidateTempIds).toEqual(state.details.map(row => row.temp_id));
  });

  it.each([3, 20, 23])('imports %i PDF details into the initial 20 rows before appending', (count) => {
    const store = useOrderFormStore.getState();
    store.setHeader({ order_name: 'E2E PDF import', client_id: 1,
      order_date: '2026-09-11', order_status_id: 1 });
    store.ensureMinimumDetailRows(20, emptyDetail);
    const slots = useOrderFormStore.getState().details;

    for (let index = 0; index < count; index++) {
      store.addPdfImportedDetail({ ...pdfDetail, detail_name: `E2E-panel-${index + 1}` });
    }

    const state = useOrderFormStore.getState();
    expect(state.details).toHaveLength(Math.max(20, count));
    expect(state.details.slice(0, Math.min(count, 20)).map(row => row.temp_id))
      .toEqual(slots.slice(0, count).map(row => row.temp_id));
    state.details.slice(0, count).forEach((row, index) => {
      expect(row).toMatchObject({ ...pdfDetail, detail_number: index + 1,
        detail_name: `E2E-panel-${index + 1}`, is_placeholder: false });
    });
    expect(state.details.slice(count)).toEqual(slots.slice(count));
    expect(state.pdfImportCandidateTempIds).toEqual(state.details.slice(0, count).map(row => row.temp_id));
    expect(new Set(state.pdfImportCandidateTempIds).size).toBe(count);
    expect(state.isDirty).toBe(true);
    expect(state.calculatedTotals()).toMatchObject({ positions_count: count,
      parts_count: count * 2, total_amount: count * 100 });
    expect(state.calculatedTotals().total_area).toBeCloseTo(count * 0.3);

    const dto = mapOrderFormToSaveOrderDto(state.getFormValues());
    expect(dto.details).toHaveLength(count);
    expect(dto.details.map(row => row.detailNumber)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    expect(dto.bazisImportCandidateClientKeys).toEqual(state.pdfImportCandidateTempIds.map(String));
  });

  it('fills PDF slots in display order while preserving edited, saved and deleted rows', () => {
    const store = useOrderFormStore.getState();
    store.ensureMinimumDetailRows(7, emptyDetail);
    const slots = useOrderFormStore.getState().details;
    useOrderFormStore.setState({ details: [
      { ...slots[0], note: 'E2E ручной ввод' },
      { ...slots[1], detail_id: 501 },
      { ...slots[2], delete_flag: true },
      { ...slots[3], is_placeholder: false, height: 700 },
      slots[6], slots[5], slots[4],
    ] });
    const protectedRows = useOrderFormStore.getState().details.slice(0, 4);

    store.addPdfImportedDetail(pdfDetail);
    store.addPdfImportedDetail({ ...pdfDetail, detail_name: 'E2E second import' });

    const state = useOrderFormStore.getState();
    expect(state.details).toHaveLength(7);
    expect(state.details.slice(0, 4)).toEqual(protectedRows);
    expect(state.details.find(row => row.detail_number === 5)).toMatchObject({ ...pdfDetail, detail_number: 5, is_placeholder: false });
    expect(state.details.find(row => row.detail_number === 6)).toMatchObject({ detail_name: 'E2E second import', is_placeholder: false });
    expect(state.details.find(row => row.detail_number === 7)).toEqual(slots[6]);
    expect(state.pdfImportCandidateTempIds).toEqual([slots[4].temp_id, slots[5].temp_id]);
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
    const storageKey = mod.getOrderDraftStorageKey('7');
    expect(sessionStorage.getItem(storageKey)).toContain('persist-me');
    expect(sessionStorage.getItem(storageKey)).toContain('"isDirty":true');
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
    expect(sessionStorage.getItem(mod.getOrderDraftStorageKey('pdf-import'))).not.toContain(
      'pdfImportCandidateTempIds',
    );

    store.getState().syncOriginals();
    expect(store.getState().pdfImportCandidateTempIds).toEqual([]);
  });

  it('destroyOrderDraftStore removes the registry entry and its sessionStorage', () => {
    const a = mod.getOrderDraftStore('9');
    a.getState().updateHeaderField('order_name', 'gone');
    const storageKey = mod.getOrderDraftStorageKey('9');
    mod.destroyOrderDraftStore('9');
    expect(sessionStorage.getItem(storageKey)).toBeNull();
    // re-create is a fresh slice
    expect(mod.getOrderDraftStore('9').getState().header.order_name).toBeUndefined();
  });

  it('refreshes linked project names without changing dirty fields, snapshots or save payload', async () => {
    const { getWorkspaceStateNamespace } = await import('../workspace/workspaceStateNamespace');
    const { collectOrderBasisProjects } = await import('../pages/orders/components/sections/orderBasisProjects');
    const store = mod.getOrderDraftStore('rename');
    const detail = { detail_id: 17, detail_number: 1, height: 500, width: 300, quantity: 1,
      area: 0.15, material_id: 1, milling_type_id: 1, edge_type_id: 1, priority: 100, detail_cost: 0,
      basis_project: 'Imported-123', bazis_project_id: 8,
      bazis_projects: [{ bazisProjectId: 8, bazisRevisionId: 3, revisionNo: 1, name: 'Old' }],
    } as OrderDetail;
    store.setState({ header: { order_name: 'Заказ', client_id: 1, order_date: '2026-09-18', order_status_id: 1 },
      details: [{ ...detail, quantity: 2 }], originalDetails: { 17: detail }, isDirty: true, version: 4 });
    const before = mapOrderFormToSaveOrderDto(store.getState().getFormValues());
    mod.syncBazisProjectNameInDrafts(8, 'Кухня № 25', getWorkspaceStateNamespace());
    const state = store.getState();
    expect(collectOrderBasisProjects(state.details)).toEqual(['Кухня № 25']);
    expect(state.details[0]).toMatchObject({ quantity: 2, basis_project: 'Imported-123' });
    expect(state.originalDetails[17]).toMatchObject({ quantity: 1, basis_project: 'Imported-123', bazis_projects: [{ name: 'Кухня № 25' }] });
    expect(state.isDirty).toBe(true);
    expect(state.version).toBe(4);
    expect(mapOrderFormToSaveOrderDto(state.getFormValues())).toEqual(before);
    mod.syncBazisProjectNameInDrafts(8, 'Wrong session', 'other-namespace');
    mod.syncBazisProjectNameInDrafts(99, 'Other project', getWorkspaceStateNamespace());
    expect(store.getState().details).toBe(state.details);
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

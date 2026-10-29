import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mapOrderFormToSaveOrderDto } from '../api/mappers/orderMapper';

let store: typeof import('./orderFormStore');
const values = new Map<string, string>();
const memory: Storage = {
  get length() { return values.size; },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => { values.delete(key); },
  setItem: (key, value) => { values.set(key, String(value)); },
};

function draft(version: number, orderKey: string) {
  values.set(store.getOrderDraftStorageKey(orderKey), JSON.stringify({
    version,
    state: {
      header: { order_id: 42, order_name: 'Тест менеджер', client_id: 5, order_date: '2026-10-29', order_status_id: 1, priority: 100, manager_id: 3, manager_name: 'Сотрудник 3' },
      details: [], payments: [], isDirty: true, version: 7,
    },
  }));
}

describe('order drafts and the manager (orders.manager.change)', () => {
  beforeAll(async () => {
    vi.stubGlobal('sessionStorage', memory);
    vi.stubGlobal('localStorage', memory);
    store = await import('./orderFormStore');
  });
  afterAll(() => vi.unstubAllGlobals());

  it('a draft of the former form loses its manager (an employee id), keeps the rest; the save keeps the stored manager', async () => {
    expect(store.ORDER_DRAFT_STORAGE_VERSION).toBe(4);
    draft(3, 'legacy-42');
    const restored = store.getOrderDraftStore('legacy-42');
    await restored.persist.rehydrate();
    const header = restored.getState().header;
    expect(header.order_name).toBe('Тест менеджер');
    expect(header.manager_id ?? null).toBeNull();
    const dto = mapOrderFormToSaveOrderDto({ ...restored.getState(), header } as never);
    expect(dto.header.managerUserId).toBeNull(); // update: null keeps the stored manager
    expect(dto.header).not.toHaveProperty('managerId');
  });

  it('a draft of the new form keeps the chosen ERP user', async () => {
    draft(4, 'current-42');
    const restored = store.getOrderDraftStore('current-42');
    await restored.persist.rehydrate();
    expect(restored.getState().header.manager_id).toBe(3);
  });
});

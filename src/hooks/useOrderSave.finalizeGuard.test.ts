import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const USE_ORDER_SAVE_PATH = join(process.cwd(), 'src/hooks/useOrderSave.ts');
const USE_ORDER_SAVE_BACKEND_PATH = join(process.cwd(), 'src/hooks/useOrderSaveBackend.ts');

describe('useOrderSave discard-aware finalize', () => {
  let store: typeof import('../stores/orderFormStore');

  beforeAll(async () => {
    vi.stubGlobal('sessionStorage', createMemoryStorage());
    vi.stubGlobal('localStorage', createMemoryStorage());
    store = await import('../stores/orderFormStore');
  });
  afterAll(() => vi.unstubAllGlobals());

  it('orderDraftStoreExists tracks create/destroy (truth source of the guard)', () => {
    expect(store.orderDraftStoreExists('555')).toBe(false);
    store.getOrderDraftStore('555');
    expect(store.orderDraftStoreExists('555')).toBe(true);
    store.destroyOrderDraftStore('555');
    expect(store.orderDraftStoreExists('555')).toBe(false);
  });

  it('peekOrderDraftStore never resurrects a discarded slice (non-creating)', () => {
    store.getOrderDraftStore('556');
    store.destroyOrderDraftStore('556');
    // peek must return undefined and must NOT recreate the Map entry...
    expect(store.peekOrderDraftStore('556')).toBeUndefined();
    expect(store.orderDraftStoreExists('556')).toBe(false);
    // ...whereas getOrderDraftStore would auto-create (the foot-gun the guard avoids).
    store.getOrderDraftStore('556');
    expect(store.orderDraftStoreExists('556')).toBe(true);
    store.destroyOrderDraftStore('556');
  });

  it('useOrderSave is scoped by order key and exports a finalize guard', () => {
    const src = readFileSync(USE_ORDER_SAVE_PATH, 'utf8');
    expect(src).toMatch(/export const shouldFinalizeSave/);
    expect(src).toMatch(/useOrderSave\s*=\s*\(orderKey: string\)/);
    expect(src).toContain('peekOrderDraftStore(orderKey)');
  });

  it('finalize (syncOriginals) only runs when the draft slice still exists', () => {
    const src = readFileSync(USE_ORDER_SAVE_PATH, 'utf8');
    // the syncOriginals success call is gated by the guard
    expect(src).toMatch(/shouldFinalizeSave\(orderKey\)[\s\S]{0,160}syncOriginals\(\)/);
    // no remaining unscoped singleton reads in the save flow
    expect(src).not.toContain('useOrderFormStore.getState()');
  });

  it('late/in-flight completion writes use the non-creating peek, never auto-create', () => {
    const src = readFileSync(USE_ORDER_SAVE_PATH, 'utf8');
    // every imperative store touch in the save flow must go through peekOrderDraftStore
    expect(src).toContain('peekOrderDraftStore(orderKey)');
    // getOrderDraftStore (auto-creating) must NOT be used in the save flow — it would
    // resurrect a discarded slice mid-save and defeat shouldFinalizeSave.
    expect(src).not.toContain('getOrderDraftStore(orderKey)');
  });

  it('backend save writes the scoped store (no unscoped singleton default leaks via the hook)', () => {
    const src = readFileSync(USE_ORDER_SAVE_PATH, 'utf8');
    expect(src).toMatch(/saveOrderViaBackend\([\s\S]{0,160}getOrderStore/);
    // backend module still keeps its own default for standalone callers/tests
    const backendSrc = readFileSync(USE_ORDER_SAVE_BACKEND_PATH, 'utf8');
    expect(backendSrc).toContain('getOrderStore');
  });
});

function createMemoryStorage(): Storage {
  const v = new Map<string, string>();
  return {
    get length() { return v.size; },
    clear() { v.clear(); },
    getItem: (k) => (v.has(k) ? v.get(k)! : null),
    key: (i) => Array.from(v.keys())[i] ?? null,
    removeItem: (k) => { v.delete(k); },
    setItem: (k, val) => { v.set(k, String(val)); },
  } as Storage;
}

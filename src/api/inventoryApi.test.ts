import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInventoryIdempotencyKey, inventoryApi } from './inventoryApi';

const { get, post, patch } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('./httpClient', () => ({ httpClient: { get, post, patch } }));

describe('inventoryApi', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('builds balances query from supported filters', async () => {
    get.mockResolvedValue({ total: 0, items: [], totalQuantity: 0 });
    await inventoryApi.balances({ warehouseId: 2, vendorId: 5, search: 'плёнка', negative: true, offset: 20, limit: 100 });
    expect(get).toHaveBeenCalledWith(expect.stringContaining('/inventory/balances?'));
    const url = String(get.mock.calls[0][0]);
    expect(url).toContain('warehouseId=2');
    expect(url).toContain('vendorId=5');
    expect(url).toContain('search=%D0%BF%D0%BB%D1%91%D0%BD%D0%BA%D0%B0');
    expect(url).toContain('negative=true');
    expect(url).toContain('offset=20');
  });

  it('builds document journal query from date, film, and order filters', async () => {
    get.mockResolvedValue({ total: 0, items: [] });
    await inventoryApi.documents({ type: 'writeoff', status: 'posted', from: '2026-09-01', to: '2026-09-28', filmId: 8, orderId: 19, offset: 20, limit: 100 });
    const url = String(get.mock.calls[0][0]);
    expect(url).toContain('type=writeoff');
    expect(url).toContain('status=posted');
    expect(url).toContain('from=2026-09-01');
    expect(url).toContain('to=2026-09-28');
    expect(url).toContain('filmId=8');
    expect(url).toContain('orderId=19');
    expect(url).toContain('offset=20');
  });

  it('keeps caller idempotency key stable across repeated commands', async () => {
    post.mockResolvedValue({ documentId: 7 });
    const body = { docType: 'receipt' as const, warehouseId: 1, docDate: '2026-09-28', lines: [{ filmId: 4, quantity: 2 }] };
    await inventoryApi.create(body, 'action-retry-key');
    await inventoryApi.create(body, 'action-retry-key');
    expect(post).toHaveBeenNthCalledWith(1, expect.stringContaining('/inventory/documents'), body, { headers: { 'Idempotency-Key': 'action-retry-key' } });
    expect(post).toHaveBeenNthCalledWith(2, expect.stringContaining('/inventory/documents'), body, { headers: { 'Idempotency-Key': 'action-retry-key' } });
  });

  it('creates valid UUID idempotency keys for new actions', () => {
    expect(createInventoryIdempotencyKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('lists warehouses with inactive ones only on request and sends warehouse commands with Idempotency-Key', async () => {
    get.mockResolvedValue({ items: [] });
    await inventoryApi.warehouses();
    await inventoryApi.warehouses({ includeInactive: true });
    expect(String(get.mock.calls[0][0])).toMatch(/\/inventory\/warehouses$/);
    expect(String(get.mock.calls[1][0])).toContain('/inventory/warehouses?includeInactive=true');
    post.mockResolvedValue({ warehouseId: 3 });
    patch.mockResolvedValue({ warehouseId: 3 });
    await inventoryApi.createWarehouse({ name: 'Склад 2', refKey1c: 'k1c' }, 'k-create');
    await inventoryApi.updateWarehouse(3, { version: 'v1', isActive: false }, 'k-update');
    expect(post).toHaveBeenCalledWith(expect.stringContaining('/inventory/warehouses'), { name: 'Склад 2', refKey1c: 'k1c' }, { headers: { 'Idempotency-Key': 'k-create' } });
    await inventoryApi.syncWarehouses('k-sync');
    expect(post).toHaveBeenLastCalledWith(expect.stringContaining('/inventory/warehouses/sync-onec'), {}, { headers: { 'Idempotency-Key': 'k-sync' } });
    expect(patch).toHaveBeenCalledWith(expect.stringContaining('/inventory/warehouses/3'), { version: 'v1', isActive: false }, { headers: { 'Idempotency-Key': 'k-update' } });
  });
});

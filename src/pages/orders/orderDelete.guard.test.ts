import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const showSource = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');
const orderFormSource = readFileSync(new URL('./components/OrderForm.tsx', import.meta.url), 'utf8');
const deletedOrderCardSource = readFileSync(new URL('./DeletedOrderCard.tsx', import.meta.url), 'utf8');

describe('order delete guards', () => {
  it('delete button is gated by the unified permission gate in BOTH cards', () => {
    for (const source of [showSource, orderFormSource]) {
      expect(source).toMatch(/canManageOrderTrash\s*=\s*!featureFlags\.useBackendPermissions\s*\|\|\s*can\('orders\.delete'\)/);
      expect(source).toContain('featureFlags.useBackendOrdersWrite && canManageOrderTrash');
      expect(source).toContain('Popconfirm');
      expect(source).toContain('ordersApi.delete');
    }
  });

  it('show page uses deleted-order fallback guards', () => {
    expect(showSource).toContain('includeDeleted: true');
    expect(showSource).toContain('DeletedOrderCard');
    expect(showSource).toMatch(/featureFlags\.useBackendOrdersRead\s*&&\s*canManageOrderTrash/);
    expect(showSource).toMatch(/const canRestore = canManageOrderTrash && featureFlags\.useBackendOrdersWrite/);
    expect(showSource).toContain('deletedOrder ? null');
    expect(showSource.match(/setDeletedOrder\(null\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(showSource).toMatch(/o\.header\.orderId\s*===\s*Number\(currentOrderId\)/);
  });

  it('deleted order card stays read-only', () => {
    expect(deletedOrderCardSource).not.toMatch(/EditButton|useOrderExport|Печать/);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const showSource = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');
const orderFormSource = readFileSync(new URL('./components/OrderForm.tsx', import.meta.url), 'utf8');
const deletedOrderCardSource = readFileSync(new URL('./DeletedOrderCard.tsx', import.meta.url), 'utf8');

describe('order delete guards', () => {
  it('delete action is gated by the unified permission gate in BOTH cards', () => {
    for (const source of [showSource, orderFormSource]) {
      expect(source).toContain('canDeleteOrderForUser');
      expect(source).toContain('featureFlags.useBackendOrdersWrite && canDeleteCurrentOrder');
      expect(source).toContain('ordersApi.delete');
      expect(source).toContain('capturePublicationGuard');
      expect(source).toContain('isSameResource(token)');
    }

    expect(showSource).toMatch(/canManageOrderTrash\s*=\s*!featureFlags\.useBackendPermissions\s*\|\|\s*can\('orders\.delete'\)/);

    expect(showSource).toContain('Modal.confirm');
    expect(showSource).toContain("key: 'delete-order'");
    expect(orderFormSource).toContain('Popconfirm');
  });

  it('show exports mask stale completion and reset busy state on resource change', () => {
    expect(showSource).toMatch(/handleExportExcel[\s\S]*showAsyncReadGuard\.capture\(\)[\s\S]*showAsyncReadGuard\.isSameResource\(exportToken\)/);
    expect(showSource).toMatch(/handleExportSnapshot[\s\S]*showAsyncReadGuard\.capture\(\)[\s\S]*showAsyncReadGuard\.isSameResource\(exportToken\)/);
    expect(showSource).toMatch(/useLayoutEffect\(\(\) => \{\s*setActiveExcelExport\(null\);\s*setIsSnapshotExporting\(false\);\s*\}, \[showAsyncReadScopeKey\]\)/);
  });

  it('show page uses deleted-order fallback guards', () => {
    expect(showSource).toContain('includeDeleted: true');
    expect(showSource).toContain('DeletedOrderCard');
    expect(showSource).toMatch(/featureFlags\.useBackendOrdersRead\s*&&\s*canManageOrderTrash/);
    expect(showSource).toMatch(/const canRestore = canManageOrderTrash && featureFlags\.useBackendOrdersWrite/);
    expect(showSource).toContain('deletedOrder ? null');
    expect(showSource.match(/setDeletedOrderState\(\{ scopeKey: showAsyncReadScopeKey, value: null \}\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(showSource).toMatch(/o\.header\.orderId\s*===\s*Number\(currentOrderId\)/);
    expect(showSource).toContain('deletedOrderState?.scopeKey === showAsyncReadScopeKey');
    expect(showSource).toContain('showAsyncReadGuard.isCurrent(token)');
    expect(showSource).toMatch(/includeDeleted: true,[\s\S]*signal: controller\.signal/);
    expect(showSource).toMatch(/return \(\) => \{[\s\S]*controller\.abort\(\)/);
  });

  it('deleted order card stays read-only', () => {
    expect(deletedOrderCardSource).not.toMatch(/EditButton|useOrderExport|Печать/);
  });
});

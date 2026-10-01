import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type { OnecCatalogReader } from '../../onec-agent/onec-catalog-reader';
import type { InventoryOnecProjectionService } from '../application/inventory-onec-projection.service';
import { InventoryService } from '../application/inventory.service';
import { InventoryController } from './inventory.controller';

const user = (permissions: string[]): CurrentUser => ({
  id: '7', username: 'u', role: 'manager', roleId: 10, permissions: permissions as CurrentUser['permissions'],
});

function setup(enabled: boolean) {
  const config = new ConfigService<BackendEnv, true>({ BACKEND_INVENTORY_ENABLED: enabled });
  const onec = { listWarehouses: vi.fn().mockResolvedValue([]) } as unknown as OnecCatalogReader;
  const service = new InventoryService({} as DatabaseService, config, onec);
  const projection = { listIssues: vi.fn(), runNow: vi.fn(), compensate: vi.fn() } as unknown as InventoryOnecProjectionService;
  const controller = new InventoryController(service, projection);
  return { service, controller, projection };
}

async function expectError(run: () => unknown, status: number, code: string) {
  try {
    await run();
  } catch (error) {
    const e = error as { statusCode?: number; code?: string };
    expect({ status: e.statusCode, code: e.code }).toEqual({ status, code });
    return;
  }
  throw new Error(`expected ${status} ${code}`);
}

describe('InventoryController', () => {
  const manualBody = { docType: 'receipt', warehouseId: 1, docDate: '2026-09-29', lines: [{ filmId: 5, quantity: 2.1 }] };

  it('answers 404 when the feature flag is off', async () => {
    const { controller } = setup(false);
    await expectError(() => controller.warehouses({ user: user(['inventory.view']) }), 404, 'NOT_FOUND');
  });

  it('requires literal inventory permissions', async () => {
    const { controller } = setup(true);
    await expectError(() => controller.warehouses({ user: user(['orders.view']) }), 403, 'FORBIDDEN');
    await expectError(() => controller.createManual({ user: user(['inventory.view']) }, 'k1', manualBody), 403, 'FORBIDDEN');
  });

  it('requires Idempotency-Key for writes', async () => {
    const { controller } = setup(true);
    await expectError(() => controller.createManual({ user: user(['inventory.manage']) }, undefined, manualBody), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.createManual({ user: user(['inventory.manage']) }, '  ', manualBody), 400, 'VALIDATION_FAILED');
  });

  it('validates bodies: order only for write-off, positive ids, bounded lines', async () => {
    const { controller } = setup(true);
    const manage = { user: user(['inventory.manage']) };
    await expectError(() => controller.createManual(manage, 'k', { ...manualBody, orderId: 3 }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.createManual(manage, 'k', { ...manualBody, lines: [] }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.createManual(manage, 'k', { ...manualBody, lines: [{ filmId: 0, quantity: 1 }] }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.createManual(manage, 'k', { ...manualBody, extra: true }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.createImport(manage, 'k', { docType: 'writeoff', warehouseId: 1, docDate: '2026-09-29', fileName: 'a', fileSha256: 'a'.repeat(64), sheetName: 's', rows: [] }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.post(manage, 'k', '1', { version: 0 }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.document({ user: user(['inventory.view']) }, 'abc'), 400, 'VALIDATION_FAILED');
  });

  it('passes a normalized manual command to the service', async () => {
    const { controller, service } = setup(true);
    const spy = vi.spyOn(service, 'createManual').mockResolvedValue({ documentId: 1 } as never);
    await controller.createManual({ user: user(['inventory.manage']), requestId: 'r1' }, ' key-1 ', {
      ...manualBody, docType: 'writeoff', orderId: 9, comment: '  ', post: true,
    });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'r1', idempotencyKey: 'key-1' }),
      { docType: 'writeoff', warehouseId: 1, docDate: '2026-09-29', orderId: 9, comment: null, lines: [{ filmId: 5, quantity: 2.1 }], post: true, allowNegative: false },
    );
  });

  it('warehouse reference: manage permission, Idempotency-Key and strict bodies', async () => {
    const { controller } = setup(true);
    const view = { user: user(['inventory.view']) };
    const manage = { user: user(['inventory.manage']) };
    const key1c = '6325798a-6fde-11ee-84da-94de808e1036';
    await expectError(() => controller.createWarehouse(view, 'k', { name: 'Склад 2', refKey1c: key1c }), 403, 'FORBIDDEN');
    await expectError(() => controller.createWarehouse(manage, 'k', { name: 'Склад 2' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.createWarehouse(manage, 'k', { name: 'Склад 2', refKey1c: 'не-ключ' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.updateWarehouse(manage, 'k', '2', { version: 'v', refKey1c: '123' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.onecWarehouses(view), 403, 'FORBIDDEN');
    await expectError(() => controller.syncWarehouses(view, 'k'), 403, 'FORBIDDEN');
    await expectError(() => controller.syncWarehouses(manage, undefined), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.updateWarehouse(view, 'k', '2', { version: 'v', name: 'Склад 3' }), 403, 'FORBIDDEN');
    await expectError(() => controller.createWarehouse(manage, undefined, { name: 'Склад 2', refKey1c: key1c }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.createWarehouse(manage, 'k', { name: '   ', refKey1c: key1c }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.createWarehouse(manage, 'k', { name: 'x'.repeat(129) }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.createWarehouse(manage, 'k', { name: 'Склад', workshopId: 40000 }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.createWarehouse(manage, 'k', { name: 'Склад', extra: 1 }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.updateWarehouse(manage, 'k', '2', { name: 'Склад' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.updateWarehouse(manage, 'k', 'abc', { version: 'v' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.updateWarehouse(manage, 'k', '40000', { version: 'v' }), 404, 'WAREHOUSE_NOT_FOUND');
  });

  it('warehouse stock: view permission, strict group/category/paging, normalized filter', async () => {
    const { controller, service } = setup(true);
    const view = { user: user(['inventory.view']) };
    await expectError(() => controller.warehouseStock({ user: user(['orders.view']) }, { warehouseId: '2' }), 403, 'FORBIDDEN');
    await expectError(() => controller.warehouseStock(view, {}), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.warehouseStock(view, { warehouseId: 'abc' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.warehouseStock(view, { warehouseId: '40000' }), 404, 'WAREHOUSE_NOT_FOUND');
    for (const group of ['film_linked', 'material:', 'material:0', 'material:x', "all' OR 1=1"]) {
      await expectError(() => controller.warehouseStock(view, { warehouseId: '2', group }), 400, 'VALIDATION_FAILED');
    }
    await expectError(() => controller.warehouseStock(view, { warehouseId: '2', categoryKey: 'сырьё' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.warehouseStock(view, { warehouseId: '2', limit: '501' }), 400, 'VALIDATION_FAILED');
    const spy = vi.spyOn(service, 'warehouseStock').mockResolvedValue({ tabs: [] } as never);
    await controller.warehouseStock(view, { warehouseId: '2', group: 'film_unlinked', categoryKey: '3C755876-EC79-11F0-A6D6-B01921AAA755', search: '  мдф ', nonZero: 'true', limit: '50' });
    expect(spy).toHaveBeenLastCalledWith(view.user, {
      warehouseId: 2, group: 'film_unlinked', categoryKey: '3c755876-ec79-11f0-a6d6-b01921aaa755',
      search: 'мдф', nonZero: true, negative: false, offset: 0, limit: 50,
    });
    await controller.warehouseStock(view, { warehouseId: '2', group: 'material:12', categoryKey: 'none' });
    expect(spy).toHaveBeenLastCalledWith(view.user, expect.objectContaining({ group: 'material:12', categoryKey: 'none', limit: 100 }));
    await controller.warehouseStock(view, { warehouseId: '2', categoryKey: '' });
    expect(spy).toHaveBeenLastCalledWith(view.user, expect.objectContaining({ categoryKey: null }));
    await controller.warehouseStock(view, { warehouseId: '2' });
    expect(spy).toHaveBeenLastCalledWith(view.user, expect.objectContaining({ group: 'all', categoryKey: null }));
  });

  it('warehouse stock answers 404 when the feature flag is off', async () => {
    const { controller } = setup(false);
    await expectError(() => controller.warehouseStock({ user: user(['inventory.view']) }, { warehouseId: '2' }), 404, 'NOT_FOUND');
  });

  it('1C consumption routes: codes validated, compensate needs a warehouse id, forwarded to the projection service', async () => {
    const { controller, projection } = setup(true);
    const view = { user: user(['inventory.view']) };
    await expectError(() => controller.onecIssues(view, { code: 'bad code' }), 400, 'VALIDATION_FAILED');
    await controller.onecIssues(view, { warehouseId: '2', code: 'FILM_UNLINKED', includeBeforeCutoff: 'true' });
    expect(projection.listIssues).toHaveBeenLastCalledWith(['inventory.view'], { warehouseId: 2, code: 'FILM_UNLINKED', includeBeforeCutoff: true, offset: 0, limit: 100 });
    await controller.runOnecConsumption(view);
    expect(projection.runNow).toHaveBeenCalledWith(['inventory.view']);
    await expectError(() => controller.compensateOnecConsumption({ user: user(['inventory.manage']) }, 'k', 'abc'), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.compensateOnecConsumption({ user: user(['inventory.manage']) }, 'k', '40000'), 404, 'WAREHOUSE_NOT_FOUND');
    await controller.compensateOnecConsumption({ user: user(['inventory.manage']), requestId: 'r' }, 'k1', '2');
    expect(projection.compensate).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: 'k1' }), 2);
  });

  it('countedAt only for inventory documents; since only as an ISO moment', async () => {
    const { controller } = setup(true);
    const manage = { user: user(['inventory.manage']) };
    await expectError(() => controller.createManual(manage, 'k', { ...manualBody, countedAt: '2026-09-26T05:14:55Z' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.createManual(manage, 'k', { ...manualBody, docType: 'inventory', countedAt: '26.09.2026' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.updateWarehouse(manage, 'k', '2', { version: 'v', onecConsumptionSince: 'вчера' }), 400, 'VALIDATION_FAILED');
  });
});

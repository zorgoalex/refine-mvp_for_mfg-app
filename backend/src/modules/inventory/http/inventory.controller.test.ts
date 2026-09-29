import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { InventoryService } from '../application/inventory.service';
import { InventoryController } from './inventory.controller';

const user = (permissions: string[]): CurrentUser => ({
  id: '7', username: 'u', role: 'manager', roleId: 10, permissions: permissions as CurrentUser['permissions'],
});

function setup(enabled: boolean) {
  const config = new ConfigService<BackendEnv, true>({ BACKEND_INVENTORY_ENABLED: enabled });
  const service = new InventoryService({} as DatabaseService, config);
  const controller = new InventoryController(service);
  return { service, controller };
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
    await expectError(() => controller.createWarehouse(view, 'k', { name: 'Склад 2' }), 403, 'FORBIDDEN');
    await expectError(() => controller.updateWarehouse(view, 'k', '2', { version: 'v', name: 'Склад 3' }), 403, 'FORBIDDEN');
    await expectError(() => controller.createWarehouse(manage, undefined, { name: 'Склад 2' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.createWarehouse(manage, 'k', { name: '   ' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.createWarehouse(manage, 'k', { name: 'x'.repeat(129) }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.createWarehouse(manage, 'k', { name: 'Склад', workshopId: 40000 }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.createWarehouse(manage, 'k', { name: 'Склад', extra: 1 }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.updateWarehouse(manage, 'k', '2', { name: 'Склад' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.updateWarehouse(manage, 'k', 'abc', { version: 'v' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.updateWarehouse(manage, 'k', '40000', { version: 'v' }), 404, 'WAREHOUSE_NOT_FOUND');
  });
});

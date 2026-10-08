import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { BackendEnv } from '../../../config/env.validation';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type { OnecCatalogReader } from '../../onec-agent/onec-catalog-reader';
import type { InventoryOnecProjectionService } from '../application/inventory-onec-projection.service';
import type { InventoryOnecSnapshotsService } from '../application/inventory-onec-snapshots.service';
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
  const snapshots = {
    list: vi.fn(), request: vi.fn(), remove: vi.fn(), card: vi.fn(), stockOf: vi.fn(), compare: vi.fn(), comparable: vi.fn(),
    assertEnabled: vi.fn(() => { if (!enabled) throw new ApiError(404, 'NOT_FOUND', 'Склад выключен'); }),
  } as unknown as InventoryOnecSnapshotsService;
  const controller = new InventoryController(service, projection, snapshots);
  return { service, controller, projection, snapshots };
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

  it('1C stock snapshot routes: moment, ids, warehouses and filters validated before the service', async () => {
    const { controller, snapshots } = setup(true);
    const view = { user: user(['inventory.view']) };
    const manage = { user: user(['inventory.manage']), requestId: 'req-1' };
    await expectError(() => controller.onecSnapshots(view, { status: 'done' }), 400, 'VALIDATION_FAILED');
    await controller.onecSnapshots(view, { status: 'ready', limit: '20' });
    expect(snapshots.list).toHaveBeenLastCalledWith(view.user, { status: 'ready', offset: 0, limit: 20 });
    // Запрос: местное время без пояса, лишние поля и отсутствие ключа — отказ до сервиса.
    for (const body of [{}, { momentLocal: '2026-09-26 10:14' }, { momentLocal: '2026-09-26T10:14:00+05:00' }, { momentLocal: '2026-09-26T10:14:00', extra: 1 }]) {
      await expectError(() => controller.requestOnecSnapshot(manage, 'key-12345', body), 400, 'VALIDATION_FAILED');
    }
    await expectError(() => controller.requestOnecSnapshot(manage, undefined, { momentLocal: '2026-09-26T10:14:00' }), 400, 'VALIDATION_FAILED');
    await controller.requestOnecSnapshot(manage, 'key-12345', { momentLocal: '2026-09-26T10:14:00', force: true });
    expect(snapshots.request).toHaveBeenLastCalledWith({ currentUser: manage.user, requestId: 'req-1', idempotencyKey: 'key-12345' }, { momentLocal: '2026-09-26T10:14:00', force: true });
    await controller.requestOnecSnapshot(manage, 'key-12345', { momentLocal: '2026-09-26T10:14:00' });
    expect(snapshots.request).toHaveBeenLastCalledWith(expect.anything(), { momentLocal: '2026-09-26T10:14:00', force: false });
    await expectError(() => controller.onecSnapshot(view, 'abc'), 400, 'VALIDATION_FAILED');
    await controller.onecSnapshot(view, '7');
    expect(snapshots.card).toHaveBeenLastCalledWith(view.user, 7);
    // Просмотр: склады через запятую, вкладка, категория (ключ или none), флаги.
    await expectError(() => controller.onecSnapshotStock(view, '7', { warehouseIds: '2,x' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.onecSnapshotStock(view, '7', { warehouseIds: '40000' }), 404, 'WAREHOUSE_NOT_FOUND');
    await expectError(() => controller.onecSnapshotStock(view, '7', { warehouseIds: Array.from({ length: 51 }, (_, i) => i + 1).join(',') }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.onecSnapshotStock(view, '7', { group: 'films' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.onecSnapshotStock(view, '7', { categoryKey: 'bad key' }), 400, 'VALIDATION_FAILED');
    await controller.onecSnapshotStock(view, '7', { warehouseIds: '2,4', group: 'film', categoryKey: 'none', search: '  мдф ', nonZero: 'true', limit: '50' });
    expect(snapshots.stockOf).toHaveBeenLastCalledWith(view.user, 7, {
      warehouseIds: [2, 4], group: 'film', categoryKey: 'none', search: 'мдф', nonZero: true, negative: false, changedOnly: false, offset: 0, limit: 50,
    });
    // Сравнение: with обязателен — current или id среза.
    await expectError(() => controller.onecSnapshotCompare(view, '7', {}), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.onecSnapshotCompare(view, '7', { with: 'now' }), 400, 'VALIDATION_FAILED');
    await controller.onecSnapshotCompare(view, '7', { with: 'current', changedOnly: 'true' });
    expect(snapshots.compare).toHaveBeenLastCalledWith(view.user, 7, 'current', expect.objectContaining({ warehouseIds: [], changedOnly: true }));
    await controller.onecSnapshotCompare(view, '7', { with: '9' });
    expect(snapshots.compare).toHaveBeenLastCalledWith(view.user, 7, 9, expect.anything());
    // Кандидаты для сравнения и страница на всё представление (выгрузка одним запросом).
    await controller.onecSnapshotComparable(view, '7', { search: ' 26.09 ', limit: '100' });
    expect(snapshots.comparable).toHaveBeenLastCalledWith(view.user, 7, { search: '26.09', offset: 0, limit: 100 });
    await expectError(() => controller.onecSnapshotComparable(view, '7', { limit: '201' }), 400, 'VALIDATION_FAILED');
    await controller.onecSnapshotStock(view, '7', { limit: '40000' });
    expect(snapshots.stockOf).toHaveBeenLastCalledWith(view.user, 7, expect.objectContaining({ limit: 40000 }));
    await expectError(() => controller.onecSnapshotStock(view, '7', { limit: '40001' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.deleteOnecSnapshot(manage, 'key-1', '0'), 400, 'VALIDATION_FAILED');
    await controller.deleteOnecSnapshot(manage, 'key-1', '7');
    expect(snapshots.remove).toHaveBeenLastCalledWith({ currentUser: manage.user, requestId: 'req-1', idempotencyKey: 'key-1' }, 7);
  });

  it('1C stock snapshot routes with the warehouse switched off answer 404 before validating the request', async () => {
    const { controller, snapshots } = setup(false);
    const view = { user: user(['inventory.view']) };
    const manage = { user: user(['inventory.manage']), requestId: 'req-1' };
    await expectError(() => controller.onecSnapshots(view, { status: 'done' }), 404, 'NOT_FOUND');
    await expectError(() => controller.requestOnecSnapshot(manage, undefined, {}), 404, 'NOT_FOUND');
    await expectError(() => controller.onecSnapshot(view, 'abc'), 404, 'NOT_FOUND');
    await expectError(() => controller.onecSnapshotStock(view, '7', { group: 'films' }), 404, 'NOT_FOUND');
    await expectError(() => controller.onecSnapshotCompare(view, '7', {}), 404, 'NOT_FOUND');
    await expectError(() => controller.onecSnapshotComparable(view, 'x', {}), 404, 'NOT_FOUND');
    await expectError(() => controller.deleteOnecSnapshot(manage, undefined, '0'), 404, 'NOT_FOUND');
    for (const method of [snapshots.list, snapshots.request, snapshots.card, snapshots.stockOf, snapshots.compare, snapshots.remove]) expect(method).not.toHaveBeenCalled();
  });

  it('1C consumption routes: codes validated, compensate needs a warehouse id, forwarded to the projection service', async () => {
    const { controller, projection } = setup(true);
    const view = { user: user(['inventory.view']) };
    await expectError(() => controller.onecIssues(view, { code: 'bad code' }), 400, 'VALIDATION_FAILED');
    await controller.onecIssues(view, { warehouseId: '2', code: 'FILM_UNLINKED', includeBeforeCutoff: 'true' });
    expect(projection.listIssues).toHaveBeenLastCalledWith(['inventory.view'], { warehouseId: 2, code: 'FILM_UNLINKED', includeBeforeCutoff: true, offset: 0, limit: 100 });
    // Ручной запуск: сервису передаются инициатор и requestId HTTP-запроса (право проверяет сервис, аудит пишет он же).
    await controller.runOnecConsumption({ ...view, requestId: 'req-run-1' });
    expect(projection.runNow).toHaveBeenCalledWith({ currentUser: view.user, requestId: 'req-run-1' });
    await expectError(() => controller.compensateOnecConsumption({ user: user(['inventory.manage']) }, 'k', 'abc'), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.compensateOnecConsumption({ user: user(['inventory.manage']) }, 'k', '40000'), 404, 'WAREHOUSE_NOT_FOUND');
    await controller.compensateOnecConsumption({ user: user(['inventory.manage']), requestId: 'r' }, 'k1', '2');
    expect(projection.compensate).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: 'k1' }), 2, { includesReceipts: false });
    // Подтверждение «откат снимает и поступления» — только явное true в теле.
    await controller.compensateOnecConsumption({ user: user(['inventory.manage']), requestId: 'r' }, 'k2', '2', { includesReceipts: 'true' });
    expect(projection.compensate).toHaveBeenLastCalledWith(expect.anything(), 2, { includesReceipts: false });
    await controller.compensateOnecConsumption({ user: user(['inventory.manage']), requestId: 'r' }, 'k3', '2', { includesReceipts: true });
    expect(projection.compensate).toHaveBeenLastCalledWith(expect.anything(), 2, { includesReceipts: true });
  });

  it('countedAt only for inventory documents; since only as an ISO moment', async () => {
    const { controller } = setup(true);
    const manage = { user: user(['inventory.manage']) };
    await expectError(() => controller.createManual(manage, 'k', { ...manualBody, countedAt: '2026-09-26T05:14:55Z' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.createManual(manage, 'k', { ...manualBody, docType: 'inventory', countedAt: '26.09.2026' }), 400, 'VALIDATION_FAILED');
    await expectError(() => controller.updateWarehouse(manage, 'k', '2', { version: 'v', onecConsumptionSince: 'вчера' }), 400, 'VALIDATION_FAILED');
  });
});

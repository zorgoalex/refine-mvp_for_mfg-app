import { ApiError } from '../../../common/errors/api-error';

// Порт срезов остатков 1С на дату (план 2026-10-08-onec-stock-snapshots-inventory-plan.md §4). Владелец — модуль
// onec-agent (сессия 1С): доставка, хранение, очередь, аудит запроса и удаления. Склад зависит только от интерфейса;
// реализация подключается в InventoryModule. Права проверяет склад ДО вызова порта.
import type { OnecStockSnapshotsPort, StockSnapshotCapabilities } from '../../onec-agent/onec-stock-snapshots.port';

export {
  ONEC_STOCK_SNAPSHOTS, STOCK_SNAPSHOT_ACTIVE_STATUSES,
  type OnecStockSnapshotsPort, type StockSnapshotCapabilities, type StockSnapshotListFilter, type StockSnapshotRequest, type StockSnapshotRow,
  type StockSnapshotStatus, type StockSnapshotView, type StockSnapshotWarehouseSummary,
} from '../../onec-agent/onec-stock-snapshots.port';

const unavailable = (): ApiError => new ApiError(409, 'ONEC_STOCK_SNAPSHOTS_UNAVAILABLE', 'Срезы остатков 1С недоступны');

/** Реализации порта нет (модуль 1С не подключён): чтения нет, команды отклоняются — вкладка срезов скрыта. */
export class UnavailableOnecStockSnapshots implements OnecStockSnapshotsPort {
  async capabilities(): Promise<StockSnapshotCapabilities> {
    return { readAvailable: false, commandsAvailable: false, reason: 'MODULE_DISABLED' };
  }
  async request(): Promise<never> { throw unavailable(); }
  async list(): Promise<{ items: never[]; total: number }> { return { items: [], total: 0 }; }
  async get(): Promise<never> { throw unavailable(); }
  async rows(): Promise<never> { throw unavailable(); }
  async summary(): Promise<never> { throw unavailable(); }
  async delete(): Promise<never> { throw unavailable(); }
}

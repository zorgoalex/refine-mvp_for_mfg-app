// Остатки листовых материалов заказа по данным 1С: та же логика, что у плёнки (остаток против потребности заказа),
// только остаток — из 1С, а потребность — площадь деталей в м². Чистые функции; чтение — в сервисе склада.
import type { OnecStockUnavailableReason, OrderSheetStockItemDto } from '../application/inventory.types';

export interface OrderSheetDemand {
  sheetMaterialTypeId: number;
  name: string;
  refKey1c: string | null;
  widthMm: number | null;
  heightMm: number | null;
  /** Потребность заказа, м²; null — нет данных. */
  demandM2: number | null;
}

export interface OnecItemBalance {
  name: string | null;
  unitName: string | null;
  byWarehouse: Array<{ warehouseId: number; name: string; quantity: number }>;
}

/** Единица 1С: листы/штуки пересчитываются в м² по размеру листа материала ERP, м² — как есть, прочие — нет. */
export function sheetUnitKind(unitName: string | null): 'sheets' | 'm2' | null {
  const unit = (unitName ?? '').trim().toLowerCase().replace(/\s+/g, '').replace(/\.$/, '');
  if (['л', 'лист', 'листов', 'шт', 'штук'].includes(unit)) return 'sheets';
  if (['м2', 'м²', 'кв.м', 'квм', 'm2'].includes(unit)) return 'm2';
  return null;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Чтение остатков 1С одного склада ERP: строки или причина, по которой их нет. */
export interface WarehouseStockReading {
  warehouseId: number;
  name: string;
  reason: OnecStockUnavailableReason | null;
  snapshotVersion: string | null;
  rows: ReadonlyArray<{ itemRefKey: string; name: string | null; unitName: string | null; quantity: number }>;
}

/**
 * Сводит чтения складов: остатки нужных позиций, полнота и самая поздняя дата снимка. Любой активный склад ERP с ключом
 * 1С, остатки которого не прочитаны (снимок не загружен, отозван, неоднозначный источник, модуль выключен, склада нет в
 * зеркале 1С или он помечен удалённым), делает данные неполными: отсутствие записи склада не доказывает нулевой остаток.
 */
export function aggregateSheetReadings(readings: readonly WarehouseStockReading[], keys: ReadonlySet<string>): {
  balances: Map<string, OnecItemBalance>;
  available: boolean;
  incomplete: Array<{ warehouseId: number; name: string; reason: OnecStockUnavailableReason }>;
  snapshotVersion: string | null;
} {
  const balances = new Map<string, OnecItemBalance>();
  const incomplete: Array<{ warehouseId: number; name: string; reason: OnecStockUnavailableReason }> = [];
  let available = false;
  let snapshotVersion: string | null = null;
  for (const reading of readings) {
    if (reading.reason !== null) {
      incomplete.push({ warehouseId: reading.warehouseId, name: reading.name, reason: reading.reason });
      continue;
    }
    available = true;
    if (reading.snapshotVersion && (!snapshotVersion || reading.snapshotVersion > snapshotVersion)) snapshotVersion = reading.snapshotVersion;
    for (const row of reading.rows) {
      if (!keys.has(row.itemRefKey)) continue;
      const current = balances.get(row.itemRefKey) ?? { name: row.name, unitName: row.unitName, byWarehouse: [] };
      current.byWarehouse.push({ warehouseId: reading.warehouseId, name: reading.name, quantity: row.quantity });
      balances.set(row.itemRefKey, current);
    }
  }
  return { balances, available, incomplete, snapshotVersion };
}

export function buildOrderSheetStock(input: {
  sheets: readonly OrderSheetDemand[];
  /** Данные 1С недоступны (ни один склад не прочитан) — статус `unavailable`. */
  onecAvailable: boolean;
  /** Часть складов не прочитана — количество частичное, покрытие `incomplete`. */
  incomplete?: boolean;
  balances: ReadonlyMap<string, OnecItemBalance>;
}): OrderSheetStockItemDto[] {
  return input.sheets.map((sheet) => {
    const base = {
      sheetMaterialTypeId: sheet.sheetMaterialTypeId, name: sheet.name, refKey1c: sheet.refKey1c,
      demandM2: sheet.demandM2 === null ? null : round2(sheet.demandM2),
    };
    if (!sheet.refKey1c) {
      return { ...base, onecName: null, unitName: null, quantity: null, quantityM2: null, warehouses: [], status: 'unlinked' as const };
    }
    if (!input.onecAvailable) {
      return { ...base, onecName: null, unitName: null, quantity: null, quantityM2: null, warehouses: [], status: 'unavailable' as const };
    }
    const balance = input.balances.get(sheet.refKey1c.toLowerCase());
    const warehouses = (balance?.byWarehouse ?? []).filter((row) => row.quantity !== 0);
    const quantity = round3(warehouses.reduce((sum, row) => sum + row.quantity, 0));
    const kind = sheetUnitKind(balance?.unitName ?? null);
    const sheetArea = sheet.widthMm && sheet.heightMm ? (sheet.widthMm * sheet.heightMm) / 1_000_000 : null;
    const quantityM2 = kind === 'm2' ? round2(quantity) : kind === 'sheets' && sheetArea !== null ? round2(quantity * sheetArea) : null;
    const status: OrderSheetStockItemDto['status'] = input.incomplete ? 'incomplete'
      : quantity <= 0 ? 'none'
      : base.demandM2 === null ? 'unknown_demand'
        : quantityM2 === null ? 'unknown_unit'
          : quantityM2 >= base.demandM2 ? 'enough' : 'short';
    return { ...base, onecName: balance?.name ?? null, unitName: balance?.unitName ?? null, quantity, quantityM2, warehouses, status };
  });
}

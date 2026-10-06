// «Остатки на складах»: чистые помощники экрана (вкладки-пресеты, состояние 1С, привязка позиции
// 1С к листовому материалу ERP, выгрузка). План spec 2026-09-30-warehouse-material-tabs-plan.md.
import type { SheetMaterialTypeDto, SheetMaterialTypeInput } from '../../api/sheetMaterialsApi';
import type { WarehouseStockDto, WarehouseStockItemDto, WarehouseStockOnecDto } from '../../api/types/inventoryApi.types';

export const DEFAULT_STOCK_GROUP = 'all';
export const FILM_GROUP = 'film';
/** Фильтр «без категории 1С». */
export const NO_CATEGORY = 'none';
const STORAGE_KEY = 'erp.inventory.stockGroup';

/** Тон числа остатка: ноль приглушается, минус выделяется (оформление задаёт вариант интерфейса). */
export function stockQuantityTone(quantity: number | null | undefined): 'negative' | 'zero' | 'ok' {
  if (quantity == null || quantity === 0) return 'zero';
  return quantity < 0 ? 'negative' : 'ok';
}

export function pageTitle(warehouseName: string | undefined): string {
  return warehouseName ? `Остатки · ${warehouseName}` : 'Остатки на складах';
}

/** Выбранная вкладка — удобство одного пользователя: пустое/недоступное хранилище не мешает экрану. */
export function readStoredGroup(): string | undefined {
  try { return window.localStorage.getItem(STORAGE_KEY) ?? undefined; } catch { return undefined; }
}
export function storeGroup(group: string): void {
  try { window.localStorage.setItem(STORAGE_KEY, group); } catch { /* приватный режим */ }
}

/** Прежний backend (нет маршрута или склад выключен) — 404 не про склад: показываем только «Плёнку». */
export function isStockUnsupported(error: unknown): boolean {
  const failure = error as { status?: number; statusCode?: number; code?: string } | null;
  const status = failure?.status ?? failure?.statusCode;
  return status === 404 && failure?.code !== 'WAREHOUSE_NOT_FOUND';
}

/**
 * Признак «сервер не умеет /inventory/stock» устойчив: после первого такого 404 запросы прекращаются.
 * Иначе смена вкладки на «Плёнку» меняет ключ запроса, ошибка сбрасывается и экран зацикливается.
 */
export function nextStockSupport(unsupported: boolean, error: unknown): boolean {
  return unsupported || isStockUnsupported(error);
}

export function stockTabs(data: WarehouseStockDto | undefined, unsupported: boolean): Array<{ key: string; label: string }> {
  if (unsupported) return [{ key: FILM_GROUP, label: 'Плёнка' }];
  if (!data) return [{ key: DEFAULT_STOCK_GROUP, label: 'Все материалы' }, { key: FILM_GROUP, label: 'Плёнка' }];
  return data.tabs.map((tab) => ({ key: tab.key, label: `${tab.label} · ${tab.count}` }));
}

/** Сохранённая вкладка могла исчезнуть (нет позиций этого типа) — вернуться к «Все материалы». */
export function resolveGroup(selected: string | undefined, data: WarehouseStockDto | undefined, unsupported: boolean): string {
  if (unsupported) return FILM_GROUP;
  const group = selected ?? DEFAULT_STOCK_GROUP;
  if (!data) return group;
  return data.tabs.some((tab) => tab.key === group) ? group : DEFAULT_STOCK_GROUP;
}

const reasonText: Record<NonNullable<WarehouseStockOnecDto['reason']>, string> = {
  onec_disabled: 'Данные 1С недоступны: модуль 1С выключен.',
  warehouse_unlinked: 'Склад не привязан к складу 1С — остатки 1С не показываются.',
  warehouse_not_in_onec: 'Склада с таким ключом нет в данных 1С — проверьте привязку в «Справочнике складов».',
  ambiguous_source: 'Склад с этим ключом есть в нескольких базах 1С — остатки 1С не показываются, чтобы не смешать базы.',
  not_loaded: 'Остатки 1С ещё не выгружались.',
  revoked: 'Данные остатков 1С отозваны.',
};

export function formatSnapshot(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU') : '—';
}

/** Сообщения над таблицами 1С: недоступность, отклонённый/неполный снимок, отозванные справочники. */
export function onecNotices(onec: WarehouseStockOnecDto | undefined): Array<{ type: 'info' | 'warning'; message: string }> {
  if (!onec) return [];
  if (!onec.available) return [{ type: 'warning', message: onec.reason ? reasonText[onec.reason] : 'Данные 1С недоступны.' }];
  const notices: Array<{ type: 'info' | 'warning'; message: string }> = [
    { type: 'info', message: `Остатки 1С на ${formatSnapshot(onec.snapshotVersion)}${onec.onecWarehouseName ? ` · склад 1С «${onec.onecWarehouseName}»` : ''}. Только просмотр.` },
  ];
  if (onec.rejectedReason) notices.push({ type: 'warning', message: `Последний снимок остатков 1С отклонён (${onec.rejectedReason}) — показан предыдущий.` });
  if (onec.completeness && onec.completeness !== 'verified') notices.push({ type: 'warning', message: 'Данные остатков 1С неполные.' });
  if (onec.directoriesRevoked) notices.push({ type: 'warning', message: 'Справочник номенклатуры 1С отозван — у строк нет названий, остатки показаны по ключам.' });
  return notices;
}

export function isOnecGroup(group: string): boolean {
  return group !== DEFAULT_STOCK_GROUP && group !== FILM_GROUP;
}

/** Действие «Привязать к листовому материалу ERP» — только для строк 1С без связи. */
export function canLinkRow(item: WarehouseStockItemDto): boolean {
  return item.source === '1c' && item.itemRefKey !== null && (item.group === 'unlinked' || item.group === 'no_type') && item.sheetMaterialTypeId === null;
}

export type LinkDecision =
  | { kind: 'link' }
  | { kind: 'already' }
  | { kind: 'confirm_replace'; currentKey: string }
  | { kind: 'inactive' };

/**
 * Решение по СВЕЖЕЙ записи листового материала (plan review R1-2): подтверждение строится после
 * чтения, PUT уходит ровно с версией прочитанной записи; при 409 — перечитать и спросить снова.
 */
export function linkDecision(fresh: Pick<SheetMaterialTypeDto, 'isActive' | 'refKey1c'>, itemRefKey: string): LinkDecision {
  if (!fresh.isActive) return { kind: 'inactive' };
  const current = fresh.refKey1c?.toLowerCase() ?? '';
  if (current === '') return { kind: 'link' };
  if (current === itemRefKey.toLowerCase()) return { kind: 'already' };
  return { kind: 'confirm_replace', currentKey: current };
}

/** Полная запись для PUT справочника: прежние поля + ключ 1С позиции. */
export function linkInput(fresh: SheetMaterialTypeDto, itemRefKey: string): SheetMaterialTypeInput {
  return {
    name: fresh.name, materialTypeId: fresh.materialTypeId, unitId: fresh.unitId,
    thicknessMm: fresh.thicknessMm, widthMm: fresh.widthMm, heightMm: fresh.heightMm,
    supplierId: fresh.supplierId, vendorId: fresh.vendorId, supplierArticle: fresh.supplierArticle,
    texture: fresh.texture, color: fresh.color, refKey1c: itemRefKey.toLowerCase(),
    isActive: fresh.isActive, isCuttable: fresh.isCuttable, sortOrder: fresh.sortOrder,
  };
}

export function stockExportRows(items: readonly WarehouseStockItemDto[]): Array<Record<string, string | number>> {
  return items.map((item) => ({
    Вкладка: item.groupLabel,
    Наименование: item.name,
    'Код 1С': item.code ?? '',
    'Поставщик / категория 1С': item.vendorName ?? item.categoryName ?? '',
    Остаток: item.quantity,
    'Ед.': item.unitName ?? '',
    Источник: item.source === 'erp' ? 'ERP' : '1С',
  }));
}

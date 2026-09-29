import type { OnecWarehouseOptionDto, WarehouseDto, WarehousePatch, WarehouseSyncResultDto } from '../../api/types/inventoryApi.types';

export interface WarehouseFormValues {
  name: string;
  refKey1c?: string | null;
  workshopId?: number | null;
  responsibleEmployeeId?: number | null;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOnecKey(value: string | null | undefined): boolean {
  return typeof value === 'string' && GUID.test(value.trim());
}

/** Причина, по которой склад нельзя отключить (backend проверяет то же под блокировкой). */
export function warehouseDeactivationBlock(warehouse: WarehouseDto): string | null {
  if (warehouse.filmsWithStock > 0) return `На складе есть остатки (${warehouse.filmsWithStock} плёнок) — отключить нельзя`;
  if (warehouse.draftDocuments > 0) return `На складе есть черновики (${warehouse.draftDocuments}) — проведите или отмените их`;
  return null;
}

/** PATCH только изменённых полей + версия; null — изменений нет. */
export function warehousePatch(before: WarehouseDto, values: WarehouseFormValues): WarehousePatch | null {
  const patch: WarehousePatch = { version: before.version };
  const name = values.name.trim();
  if (name !== before.name) patch.name = name;
  const refKey1c = values.refKey1c?.trim().toLowerCase() || null;
  if (refKey1c !== null && refKey1c !== (before.refKey1c ?? '').toLowerCase()) patch.refKey1c = refKey1c;
  const workshopId = values.workshopId ?? null;
  if (workshopId !== before.workshopId) patch.workshopId = workshopId;
  const responsibleEmployeeId = values.responsibleEmployeeId ?? null;
  if (responsibleEmployeeId !== before.responsibleEmployeeId) patch.responsibleEmployeeId = responsibleEmployeeId;
  return Object.keys(patch).length > 1 ? patch : null;
}

/** Варианты склада 1С: привязанные к другому складу ERP недоступны и подписаны. */
export function onecWarehouseOptions(items: OnecWarehouseOptionDto[], currentWarehouseId: number | null) {
  return items.map((item) => {
    const takenByOther = item.linkedWarehouseId !== null && item.linkedWarehouseId !== currentWarehouseId;
    const code = item.code ? ` (${item.code})` : '';
    return {
      value: item.refKey,
      label: takenByOther ? `${item.name}${code} — уже: ${item.linkedWarehouseName}` : `${item.name}${code}`,
      disabled: takenByOther,
      name: item.name,
    };
  });
}

export function onecStatusText(warehouse: WarehouseDto): { text: string; tone: 'ok' | 'warning' | 'error' | 'muted' } {
  switch (warehouse.onecStatus) {
    case 'linked': return { text: `${warehouse.onecName ?? ''}${warehouse.onecCode ? ` (${warehouse.onecCode})` : ''}`, tone: 'ok' };
    case 'missing': return { text: 'Нет в данных 1С', tone: 'warning' };
    case 'unlinked': return { text: 'Не привязан к 1С', tone: 'error' };
    default: return { text: warehouse.refKey1c ?? '—', tone: 'muted' };
  }
}

export function syncSummary(result: WarehouseSyncResultDto): string {
  const parts = [`добавлено ${result.created.length}`, `привязано ${result.linked.length}`];
  if (result.skipped.length > 0) parts.push(`пропущено ${result.skipped.length} (название занято: ${result.skipped.map((row) => row.name).join(', ')})`);
  return `Синхронизация с 1С: ${parts.join(', ')}`;
}

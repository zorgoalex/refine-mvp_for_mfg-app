import type { WarehouseDto, WarehousePatch } from '../../api/types/inventoryApi.types';

export interface WarehouseFormValues {
  name: string;
  workshopId?: number | null;
  responsibleEmployeeId?: number | null;
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
  const workshopId = values.workshopId ?? null;
  if (workshopId !== before.workshopId) patch.workshopId = workshopId;
  const responsibleEmployeeId = values.responsibleEmployeeId ?? null;
  if (responsibleEmployeeId !== before.responsibleEmployeeId) patch.responsibleEmployeeId = responsibleEmployeeId;
  return Object.keys(patch).length > 1 ? patch : null;
}

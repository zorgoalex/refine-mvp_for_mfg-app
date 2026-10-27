import { ApiError } from '../../../common/errors/api-error';
import type { AuditRelatedEntity } from '../../../common/audit/audit-event.types';

/** Чей список поставщиков (migr 280, `material_suppliers.resource_kind`). */
export type MaterialKind = 'film' | 'sheet_material' | 'extra_resource';

export interface MaterialSupplierRef {
  id: number;
  name: string;
  isActive: boolean;
}

/** Не больше поставщиков у одной позиции. */
export const MAX_MATERIAL_SUPPLIERS = 20;

/**
 * Список id поставщиков из запроса: целые > 0, без повторов, не длиннее лимита. `undefined` — поля нет
 * (не менять); `null` — очистить.
 */
export function parseSupplierIds(value: unknown, field: string): number[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_MATERIAL_SUPPLIERS || !value.every((id) => Number.isInteger(id) && id > 0)) {
    throw invalid(`${field}: список id поставщиков (не больше ${MAX_MATERIAL_SUPPLIERS})`);
  }
  if (new Set(value).size !== value.length) throw invalid(`${field}: поставщик указан дважды`);
  return value as number[];
}

/**
 * Список листового = основной (`sheet_material_types.supplier_id`) + дополнительные по порядку; основной, если он же
 * оказался в дополнительных (его выбрал прежний backend), — один раз, первым.
 */
export function composeSheetSuppliers(main: MaterialSupplierRef | null, additional: MaterialSupplierRef[]): MaterialSupplierRef[] {
  const list = main ? [main] : [];
  for (const supplier of additional) if (!list.some((item) => item.id === supplier.id)) list.push(supplier);
  return list;
}

/** Дополнительные листового без основного (продвижение основного из дополнительных). */
export function additionalWithoutMain(mainId: number | null, additional: number[]): number[] {
  return mainId === null ? additional : additional.filter((id) => id !== mainId);
}

/** Связанные сущности аудита: все поставщики до и после правки (по удалённому поставщику историю тоже найти). */
export function supplierRelatedEntities(before: readonly number[], after: readonly number[]): AuditRelatedEntity[] {
  return [...new Set([...before, ...after])].sort((a, b) => a - b).map((entityId) => ({ entityType: 'supplier', entityId }));
}

export function sameIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function invalid(message: string): ApiError {
  return new ApiError(422, 'MATERIAL_SUPPLIER_INVALID', message);
}

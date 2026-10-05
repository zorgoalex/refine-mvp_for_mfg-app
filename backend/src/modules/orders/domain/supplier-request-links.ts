import type { OnecUnitCode } from '../application/onec-documents.types';
import type { OrderResourceUnit } from '../application/order-resource-demand.types';
import { fromThousandths, toDemandUnit, toThousandths, type ProcurementDocUnit } from './procurement-worklist';

/**
 * Поставщик документа 1С и поставщик заявки (§5.5): совпадение, если ключ заявки среди ключей документа; явное
 * расхождение — если с обеих сторон есть идентичность одного вида и она разная; иначе не определить (1С-контрагент
 * против поставщика ERP без ключа 1С) — привязка разрешена с предупреждением.
 */
export type SupplierMatch = 'match' | 'unknown' | 'mismatch';

export function supplierMatch(
  requestKey: string,
  doc: { supplierId: number | null; counterpartyRefKey: string | null; keys: readonly string[] },
): SupplierMatch {
  if (requestKey === 'none') return 'unknown';
  if (doc.keys.includes(requestKey)) return 'match';
  if (requestKey.startsWith('s:') && doc.supplierId !== null) return 'mismatch';
  if (requestKey.startsWith('c:') && doc.counterpartyRefKey !== null) return 'mismatch';
  if (requestKey.startsWith('n:') && doc.keys.some((key) => key.startsWith('n:'))) return 'mismatch';
  return 'unknown';
}

/**
 * Количество из одной единицы строки в другую через единицу потребности (лист ↔ м² по площади листа), в тысячных.
 * null — единицы несовместимы. Одинаковые единицы — без пересчёта.
 */
export function convertThousandths(
  quantity: number,
  from: OnecUnitCode | null,
  to: OnecUnitCode | null,
  demandUnit: OrderResourceUnit,
  sheetAreaM2: number | null,
): number | null {
  if (from === null || to === null) return null;
  if (from === to) return quantity;
  const geometry = { sheetAreaM2 };
  const inDemand = toDemandUnit(fromThousandths(quantity), from as ProcurementDocUnit, demandUnit, geometry);
  if (inDemand === null) return null;
  if (to === demandUnit) return toThousandths(inDemand);
  if (to === 'sheet' && demandUnit === 'm2' && sheetAreaM2 !== null && sheetAreaM2 > 0) return Math.round((inDemand / sheetAreaM2) * 1000);
  return null;
}

export type LineOrderFulfillment = 'waiting' | 'partial' | 'received';

/**
 * Допуск исполнения, тысячные единицы строки заявки: заявка округляет заказ вверх до 0,001, подбор — связь вниз, поэтому
 * «пришло 0,55 из 0,551 листа» — это получено. Лимит привязки (не больше заказанного) остаётся строгим.
 */
export const FULFILLMENT_SLACK = 1;

/** Сколько ещё ждём по заказу строки заявки (тысячные); хвост в пределах допуска — 0. */
export function openThousandths(ordered: number, fulfilled: number): number {
  const open = Math.max(0, ordered - fulfilled);
  // Допуск — только когда приход уже есть: заказ на 0,001 без прихода остаётся открытым (CR5-1).
  return fulfilled > 0 && open <= FULFILLMENT_SLACK ? 0 : open;
}

/** Исполнение заказа строки заявки по приходным связям (тысячные единицы строки заявки). */
export function fulfillmentOf(ordered: number, fulfilled: number): LineOrderFulfillment {
  if (fulfilled <= 0) return 'waiting';
  return openThousandths(ordered, fulfilled) === 0 ? 'received' : 'partial';
}

/** Не больше стольких связей с заявками у одного распределения за одну команду (batch DTO, подбор). */
export const MAX_REQUEST_LINKS_PER_ALLOCATION = 20;

/**
 * Количество (в единице строки) в единице потребности БЕЗ округления — для сумм по нескольким связям (CR1-2):
 * округление каждой связи отдельно позволило бы привязать больше, чем пришло. null — единицы несовместимы.
 */
export function inDemandExact(quantity: number, unit: OnecUnitCode | null, demandUnit: OrderResourceUnit, sheetAreaM2: number | null): number | null {
  if (unit === null) return null;
  if (unit === demandUnit) return quantity;
  if (unit === 'sheet' && demandUnit === 'm2' && sheetAreaM2 !== null && sheetAreaM2 > 0) return quantity * sheetAreaM2;
  return null;
}

/** Из единицы потребности в единицу строки заявки вниз до 0,001 (подсказки и подбор проходят проверку команды). */
export function fromDemandFloor(demandQuantity: number, unit: OnecUnitCode, demandUnit: OrderResourceUnit, sheetAreaM2: number | null): number | null {
  if (unit === demandUnit) return Math.floor(demandQuantity * 1000 + 1e-6) / 1000;
  if (unit === 'sheet' && demandUnit === 'm2' && sheetAreaM2 !== null && sheetAreaM2 > 0) return Math.floor((demandQuantity / sheetAreaM2) * 1000 + 1e-6) / 1000;
  return null;
}

/** Допуск сравнения сумм в единице потребности (погрешность float), много меньше 0,001. */
export const DEMAND_EPSILON = 1e-7;

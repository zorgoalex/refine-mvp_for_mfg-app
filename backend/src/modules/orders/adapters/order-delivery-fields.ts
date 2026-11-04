import type { NormalizedSaveOrderHeaderDto } from '../dto/save-order.dto';

/** Header keys → orders columns of the delivery / start shift fields (ERP → 1C phase 1). */
const COLUMNS = {
  deliveryMethod: 'delivery_method',
  deliveryAddress: 'delivery_address',
  deliveryNotes: 'delivery_notes',
  startShift: 'start_shift',
} as const satisfies Partial<Record<keyof NormalizedSaveOrderHeaderDto, string>>;

type DeliveryKey = keyof typeof COLUMNS;
type DeliveryHeader = Pick<NormalizedSaveOrderHeaderDto, DeliveryKey>;

/** Keys the request carried: an absent key keeps the stored value (an older open form cannot wipe them). */
function presentKeys(header: DeliveryHeader): DeliveryKey[] {
  return (Object.keys(COLUMNS) as DeliveryKey[]).filter((key) => Object.prototype.hasOwnProperty.call(header, key));
}

/**
 * SET fragment for the header UPDATE of the SAME statement (no second UPDATE: the orders triggers — CRM sync, Bitrix24,
 * realtime, stage letters — must fire once per save). `firstIndex` is the next free `$n` of the statement. Empty when
 * the request carried none of the keys; an explicit null clears.
 */
export function orderDeliveryUpdateSet(header: DeliveryHeader, firstIndex: number): { sql: string; values: unknown[] } {
  const keys = presentKeys(header);
  return {
    sql: keys.map((key, index) => `, ${COLUMNS[key]} = $${firstIndex + index}`).join(''),
    values: keys.map((key) => header[key] ?? null),
  };
}

/** Column and value fragments for the header INSERT of the same statement (absent keys stay NULL by default). */
export function orderDeliveryInsert(header: DeliveryHeader, firstIndex: number): { columns: string; placeholders: string; values: unknown[] } {
  const keys = presentKeys(header);
  return {
    columns: keys.map((key) => `, ${COLUMNS[key]}`).join(''),
    placeholders: keys.map((_, index) => `, $${firstIndex + index}`).join(''),
    values: keys.map((key) => header[key] ?? null),
  };
}

/** The four fields of a stored order, for read DTOs. */
export interface OrderDeliveryFieldsView {
  deliveryMethod: 'courier' | 'pickup' | null;
  deliveryAddress: string | null;
  deliveryNotes: string | null;
  startShift: number | null;
}

/** Maps the four columns of an orders row (snake_case) to the read view. */
export function orderDeliveryFieldsView(row: {
  delivery_method?: string | null;
  delivery_address?: string | null;
  delivery_notes?: string | null;
  start_shift?: number | string | null;
}): OrderDeliveryFieldsView {
  const method = row.delivery_method === 'courier' || row.delivery_method === 'pickup' ? row.delivery_method : null;
  return {
    deliveryMethod: method,
    deliveryAddress: row.delivery_address ?? null,
    deliveryNotes: row.delivery_notes ?? null,
    startShift: row.start_shift === null || row.start_shift === undefined ? null : Number(row.start_shift),
  };
}

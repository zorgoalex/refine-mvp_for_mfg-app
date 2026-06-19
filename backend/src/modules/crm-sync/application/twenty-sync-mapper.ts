import { createHash } from 'node:crypto';
import type { ClientRow, OrderRow } from './crm-sync.types';

/**
 * Returns 'deleted' when the record is soft-deleted, 'active' otherwise.
 * Callers pass `!client.isActive` or `order.deleteFlag`.
 */
export function erpStatusFor(isDeleted: boolean): 'active' | 'deleted' {
  return isDeleted ? 'deleted' : 'active';
}

/**
 * Convert an ERP DATE string ('YYYY-MM-DD') to a Twenty DATE_TIME ISO string.
 * Returns null when the value is null.
 */
function toDateTime(d: string | null): string | null {
  if (d === null) return null;
  return `${d}T00:00:00.000Z`;
}

/**
 * Map a ClientRow to the Twenty Company payload.
 * Only sends confirmed custom/native fields: name, erpId, erpStatus.
 * NOTE: `notes` is intentionally excluded — Company has no notes field in the
 * confirmed Twenty workspace; projecting it would break the create.
 */
export function mapClient(client: ClientRow): Record<string, unknown> {
  return {
    name: client.clientName,
    erpId: client.clientId,
    erpStatus: erpStatusFor(!client.isActive),
  };
}

/**
 * Map an OrderRow to the Twenty ErpOrder payload.
 * `companyId` is the Twenty Company record ID (relation write field).
 */
export function mapOrder(order: OrderRow, companyId: string): Record<string, unknown> {
  return {
    name: order.orderName,
    erpId: order.orderId,
    erpStatus: erpStatusFor(order.deleteFlag),
    orderNumber: order.orderNumber,
    orderStatus: order.orderStatusName,
    paymentStatus: order.paymentStatusName,
    totalAmount: order.totalAmount,
    finalAmount: order.finalAmount,
    paidAmount: order.paidAmount,
    orderDate: toDateTime(order.orderDate),
    completionDate: toDateTime(order.completionDate),
    companyId,
  };
}

/**
 * Recursively sort the keys of an object (and any nested objects/arrays) to
 * produce a stable canonical form before serializing to JSON.
 */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortedKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Return a SHA-1 hex digest of the payload.
 * Keys are sorted recursively before serialization so the hash is independent
 * of the insertion order of properties.  Used by the sync consumer to skip
 * no-op upserts.
 */
export function hash(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(sortedKeys(payload));
  return createHash('sha1').update(canonical).digest('hex');
}

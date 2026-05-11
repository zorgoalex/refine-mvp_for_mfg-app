import type { CalendarOrder } from '../types/calendar';

const orderVersions = new Map<number, number>();

export function applyKnownCalendarOrderVersion(order: CalendarOrder): void {
  const knownVersion = orderVersions.get(order.order_id);
  if (
    Number.isInteger(knownVersion) &&
    (!Number.isInteger(order.version) || knownVersion > order.version)
  ) {
    order.version = knownVersion;
  }
}

export function reserveCalendarOrderVersion(orderId: number, version: unknown): void {
  const currentVersion = orderVersions.get(orderId);
  if (
    Number.isInteger(version) &&
    (!Number.isInteger(currentVersion) || (version as number) > currentVersion)
  ) {
    orderVersions.set(orderId, version as number);
  }
}

export function setCalendarOrderVersion(orderId: number, version: unknown): void {
  if (Number.isInteger(version)) {
    orderVersions.set(orderId, version as number);
  }
}

export function forgetCalendarOrderVersion(orderId: number): void {
  orderVersions.delete(orderId);
}

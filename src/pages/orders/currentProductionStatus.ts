interface ActiveProductionEvent {
  production_status_id: number;
}

export function buildActiveProductionStatusCodeMap(
  statuses: readonly Record<string, unknown>[],
): Map<number, string> {
  return new Map(
    statuses
      .filter((status) => (
        status.is_active === true
        && typeof status.production_status_id === 'number'
        && typeof status.production_status_code === 'string'
      ))
      .map((status) => [
        status.production_status_id as number,
        status.production_status_code as string,
      ]),
  );
}

export function resolveActiveProductionEventCodes(
  events: readonly ActiveProductionEvent[],
  statusIdToCode: ReadonlyMap<number, string>,
): string[] {
  const codes = events
    .map((event) => statusIdToCode.get(event.production_status_id)?.trim())
    .filter((code): code is string => Boolean(code));

  return [...new Set(codes)];
}

/**
 * Stage letters of an order: only its own marks, the same state the status menus check.
 * Event codes (legacy Hasura read path) win; otherwise the backend projection, which is
 * built from the same order-level events. Detail stages never become order letters.
 */
export function resolveOrderStageCodes(
  backendCodes: unknown,
  eventCodes?: readonly (string | null | undefined)[],
): string[] {
  const source: readonly unknown[] = eventCodes ?? (Array.isArray(backendCodes) ? backendCodes : []);
  const codes = source
    .map((code) => (typeof code === 'string' ? code.trim() : ''))
    .filter(Boolean);

  return [...new Set(codes)];
}

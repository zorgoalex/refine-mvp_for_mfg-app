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
 * Loaded event codes win; otherwise the backend projection, built from the same
 * order-level events. Detail stages reach the marks only through the database.
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

interface StageSourceDetail {
  detail_id?: number | null;
  order_hdf_detail_id?: number | null;
  production_status_id?: number | null;
}

/**
 * Changes whenever a stage that sets or clears order marks in the database changes:
 * ordinary details and HDF details. Used as a key to re-read the marks.
 */
export function buildStageMarksSignature(
  details: readonly StageSourceDetail[] = [],
  hdfDetails: readonly StageSourceDetail[] = [],
): string {
  const part = (rows: readonly StageSourceDetail[], id: (row: StageSourceDetail) => unknown) => rows
    .map((row) => `${id(row) ?? ''}:${row.production_status_id ?? ''}`)
    .join(',');
  return `${part(details, (row) => row.detail_id)}|${part(hdfDetails, (row) => row.order_hdf_detail_id)}`;
}

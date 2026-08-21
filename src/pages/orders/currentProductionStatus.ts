import { getPassedCodesFromStatusName } from '../../components/ProductionStagesDisplay';

interface ProductionStatusValue {
  statusId?: number | null;
  statusName?: string | null;
}

interface CurrentProductionStatusInput extends ProductionStatusValue {
  statusIdToCode: ReadonlyMap<number, string>;
  passedCodes?: readonly (string | null | undefined)[];
  detailStatuses?: readonly ProductionStatusValue[];
}

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

export function resolveCurrentProductionStatusCodes({
  statusId,
  statusName,
  statusIdToCode,
  passedCodes = [],
  detailStatuses = [],
}: CurrentProductionStatusInput): string[] {
  const codes = new Set<string>();

  const addCode = (code?: string | null) => {
    const normalizedCode = code?.trim();
    if (normalizedCode) codes.add(normalizedCode);
  };

  const addStatus = (status: ProductionStatusValue) => {
    if (typeof status.statusId === 'number') {
      const code = statusIdToCode.get(status.statusId);
      if (code) {
        addCode(code);
        return;
      }
    }

    if (status.statusName) {
      getPassedCodesFromStatusName(status.statusName).forEach(addCode);
    }
  };

  passedCodes.forEach(addCode);
  addStatus({ statusId, statusName });
  detailStatuses.forEach(addStatus);

  return [...codes];
}

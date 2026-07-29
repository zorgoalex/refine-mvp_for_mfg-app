import { getPassedCodesFromStatusName } from '../../components/ProductionStagesDisplay';

interface CurrentProductionStatusInput {
  statusId?: number | null;
  statusName?: string | null;
  statusIdToCode: ReadonlyMap<number, string>;
}

export function resolveCurrentProductionStatusCodes({
  statusId,
  statusName,
  statusIdToCode,
}: CurrentProductionStatusInput): string[] {
  if (typeof statusId === 'number') {
    const code = statusIdToCode.get(statusId)?.trim();
    if (code) return [code];
  }

  return statusName ? getPassedCodesFromStatusName(statusName) : [];
}

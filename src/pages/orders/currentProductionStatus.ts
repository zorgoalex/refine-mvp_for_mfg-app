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

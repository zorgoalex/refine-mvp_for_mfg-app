import type { CalendarOrder, CalendarOrderDetail } from '../types/calendar';
import type { ProductionStatusRef } from '../../../types/productionWorkflow';

export interface ProductionStatusCodeLookup {
  idToCode: Map<number, string>;
  uniqueNameToCode: Map<string, string>;
}

const normalizeStatusName = (value: string): string => value.trim().toLocaleLowerCase('ru-RU');

export const buildProductionStatusCodeLookup = (
  statuses: ProductionStatusRef[],
): ProductionStatusCodeLookup => {
  const idToCode = new Map<number, string>();
  const codesByName = new Map<string, Set<string>>();

  statuses.forEach((status) => {
    const code = status.production_status_code?.trim();
    if (!code) return;
    idToCode.set(status.production_status_id, code);

    const normalizedName = normalizeStatusName(status.production_status_name || '');
    if (!normalizedName) return;
    const codes = codesByName.get(normalizedName) ?? new Set<string>();
    codes.add(code);
    codesByName.set(normalizedName, codes);
  });

  const uniqueNameToCode = new Map<string, string>();
  codesByName.forEach((codes, name) => {
    if (codes.size === 1) uniqueNameToCode.set(name, [...codes][0]);
  });

  return { idToCode, uniqueNameToCode };
};

export const resolveCalendarProductionStatusCodes = ({
  order,
  details,
  eventCodes = [],
  lookup,
}: {
  order: CalendarOrder;
  details: CalendarOrderDetail[];
  eventCodes?: string[];
  lookup: ProductionStatusCodeLookup;
}): string[] => {
  const codes = new Set<string>();
  const add = (code?: string | null) => {
    const normalized = code?.trim();
    if (normalized) codes.add(normalized);
  };

  eventCodes.forEach(add);
  order.passed_production_status_codes?.forEach(add);
  add(order.production_status_id == null ? undefined : lookup.idToCode.get(order.production_status_id));
  if (order.production_status_name) {
    add(lookup.uniqueNameToCode.get(normalizeStatusName(order.production_status_name)));
  }
  details.forEach((detail) => {
    if (detail.production_status_id != null) add(lookup.idToCode.get(detail.production_status_id));
    else if (detail.production_status_name) {
      add(lookup.uniqueNameToCode.get(normalizeStatusName(detail.production_status_name)));
    }
  });

  return [...codes];
};

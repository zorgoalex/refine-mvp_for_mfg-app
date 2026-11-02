import type { CalendarOrder } from '../types/calendar';
import type { ProductionStatusRef } from '../../../types/productionWorkflow';
import { resolveOrderStageCodes } from '../../orders/currentProductionStatus';

export interface ProductionStatusCodeLookup {
  idToCode: Map<number, string>;
}

export const buildProductionStatusCodeLookup = (
  statuses: ProductionStatusRef[],
): ProductionStatusCodeLookup => {
  const idToCode = new Map<number, string>();
  statuses.forEach((status) => {
    const code = status.production_status_code?.trim();
    if (code) idToCode.set(status.production_status_id, code);
  });
  return { idToCode };
};

// Card letters are the backend projection (passed_production_status_codes);
// manual ones (set by hand) are shown in another colour.
export const resolveCalendarProductionStatusCodes = ({
  order,
}: {
  order: CalendarOrder;
}): string[] => resolveOrderStageCodes(order.passed_production_status_codes);

export const resolveCalendarManualProductionStatusCodes = ({
  order,
}: {
  order: CalendarOrder;
}): string[] => resolveOrderStageCodes(order.manual_production_status_codes);

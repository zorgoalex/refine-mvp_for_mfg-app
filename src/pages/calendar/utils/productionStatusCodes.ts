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

// Card letters are the order stage marks, the same set the stage menu checks.
// Detail stages reach the marks through the database (migration 266).
// eventCodes undefined = events not loaded yet; then the backend projection.
export const resolveCalendarProductionStatusCodes = ({
  order,
  eventCodes,
}: {
  order: CalendarOrder;
  eventCodes?: string[];
}): string[] => resolveOrderStageCodes(order.passed_production_status_codes, eventCodes);

import { mapOrderDtoToFormValues } from '../../api/mappers/orderMapper';
import type { OrderDto } from '../../api/types/orderApi.types';
import type { OrderHdfDetail } from '../../types/orders';

/**
 * ХДФ parts of the opened order. The backend read already hands the card mapped form values
 * (`order_hdf_detail_id`, `status`, `area_m2`…); mapping them a second time as a DTO wiped every
 * field, so ХДФ never reached «Листовые материалы» and the ХДФ column. A raw DTO is still mapped.
 */
export function resolveOrderShowHdfDetails(backendOrder: unknown): OrderHdfDetail[] {
  if (!backendOrder || typeof backendOrder !== 'object') return [];
  const raw = (backendOrder as { hdfDetails?: unknown }).hdfDetails;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const first = raw[0] as Record<string, unknown> | null;
  if (first && typeof first === 'object' && 'order_hdf_detail_id' in first) return raw as OrderHdfDetail[];
  return mapOrderDtoToFormValues(backendOrder as OrderDto).hdfDetails ?? [];
}

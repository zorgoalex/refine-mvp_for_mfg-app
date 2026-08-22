import type { Key } from 'react';
import type { OrderDetail, OrderHdfDetail } from '../../../../types/orders';

export interface HdfParameterDisplay {
  value: number | null;
  pending: boolean;
}

export function collectSelectedHdfSourceDetailIds(
  hdfDetails: readonly OrderHdfDetail[],
  selectedRowKeys: readonly Key[],
): number[] {
  const selectedIds = new Set(selectedRowKeys.map(positiveId).filter((id): id is number => id !== null));
  const sourceIds = hdfDetails
    .filter((detail) => selectedIds.has(detail.order_hdf_detail_id))
    .map((detail) => positiveId(detail.source_order_detail_id_snapshot))
    .filter((id): id is number => id !== null);
  return [...new Set(sourceIds)];
}

export function resolveHdfParameterDisplay(
  hdfDetail: OrderHdfDetail,
  sourceDetailById: ReadonlyMap<number, OrderDetail>,
): HdfParameterDisplay {
  const sourceDetailId = positiveId(hdfDetail.source_order_detail_id_snapshot);
  const calculatedValue = positiveNumber(hdfDetail.edge_mm);
  if (sourceDetailId === null) return { value: calculatedValue, pending: false };

  const overrideValue = positiveNumber(sourceDetailById.get(sourceDetailId)?.hdf_parameter_override_mm);
  if (overrideValue === null) return { value: calculatedValue, pending: false };
  return {
    value: overrideValue,
    pending: calculatedValue === null || Math.abs(overrideValue - calculatedValue) > 0.0001,
  };
}

function positiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

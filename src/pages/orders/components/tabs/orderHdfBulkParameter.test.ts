import { describe, expect, it } from 'vitest';
import type { OrderDetail, OrderHdfDetail } from '../../../../types/orders';
import {
  collectSelectedHdfSourceDetailIds,
  resolveHdfParameterDisplay,
} from './orderHdfBulkParameter';

function hdf(id: number, sourceId: number, edgeMm: number | null = 60): OrderHdfDetail {
  return {
    order_hdf_detail_id: id,
    source_order_detail_id_snapshot: sourceId,
    edge_mm: edgeMm,
    area_m2: 1,
    status: 'ok',
    version: 1,
  };
}

function source(id: number, override: number | null): OrderDetail {
  return {
    detail_id: id,
    detail_number: id,
    height: 100,
    width: 100,
    quantity: 1,
    area: 0.01,
    material_id: null,
    milling_type_id: 1,
    hdf_parameter_override_mm: override,
    edge_type_id: 1,
    priority: 100,
  };
}

describe('HDF bulk parameter helpers', () => {
  it('maps selected HDF rows to unique source detail ids', () => {
    expect(collectSelectedHdfSourceDetailIds(
      [hdf(11, 101), hdf(12, 102), hdf(13, 101)],
      [11, 13, 999],
    )).toEqual([101]);
  });

  it('shows the calculated milling default when no override exists', () => {
    expect(resolveHdfParameterDisplay(hdf(11, 101, 60), new Map([[101, source(101, null)]])))
      .toEqual({ value: 60, pending: false });
  });

  it('marks a newly applied order-detail override as pending', () => {
    expect(resolveHdfParameterDisplay(hdf(11, 101, 60), new Map([[101, source(101, 42.5)]])))
      .toEqual({ value: 42.5, pending: true });
  });

  it('does not mark an already recalculated override as pending', () => {
    expect(resolveHdfParameterDisplay(hdf(11, 101, 42.5), new Map([[101, source(101, 42.5)]])))
      .toEqual({ value: 42.5, pending: false });
  });
});

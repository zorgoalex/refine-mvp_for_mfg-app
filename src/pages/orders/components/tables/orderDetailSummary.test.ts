import { describe, expect, it } from 'vitest';
import type { OrderDetail } from '../../../../types/orders';
import { calculateLiveOrderDetailCostTotal } from './orderDetailSummary';

const detail = (values: Partial<OrderDetail>): OrderDetail => ({
  detail_number: 1,
  height: 1,
  width: 1,
  quantity: 1,
  area: 1,
  material_id: null,
  milling_type_id: 1,
  edge_type_id: 1,
  priority: 1,
  ...values,
} as OrderDetail);

describe('calculateLiveOrderDetailCostTotal', () => {
  it('sums saved detail costs', () => {
    expect(calculateLiveOrderDetailCostTotal([
      detail({ detail_id: 1, detail_cost: 100 }),
      detail({ detail_id: 2, detail_cost: 50.5 }),
    ], null, undefined)).toBe(150.5);
  });

  it('uses the current editor value instead of the stale row value', () => {
    expect(calculateLiveOrderDetailCostTotal([
      detail({ temp_id: 'draft-1', detail_cost: 100 }),
      detail({ detail_id: 2, detail_cost: 50 }),
    ], 'draft-1', 275.5)).toBe(325.5);
  });
});

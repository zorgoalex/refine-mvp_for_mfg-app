import { describe, expect, it } from 'vitest';
import type { NormalizedSaveOrderDetailDto } from '../dto/save-order.dto';
import { OrderFinalAmountNegativeError } from '../errors/order.errors';
import {
  calculateDetailArea,
  calculateDetailCost,
  calculateOrderDetails,
  calculateOrderTotals,
  calculatePaymentStatusId,
} from './order-calculations';

function createDetail(
  overrides: Partial<NormalizedSaveOrderDetailDto> = {},
): NormalizedSaveOrderDetailDto {
  return {
    detailName: null,
    height: 550,
    width: 200,
    quantity: 2,
    materialId: 1001,
    millingTypeId: 1001,
    edgeTypeId: 1001,
    filmId: null,
    area: null,
    millingCostPerSqm: null,
    detailCost: 10000,
    priority: 100,
    productionStatusId: null,
    jointOrderId: null,
    note: null,
    linkCuttingFile: null,
    linkCuttingImageFile: null,
    linkCadFile: null,
    linkPdfFile: null,
    refKey1c: null,
    ...overrides,
  };
}

describe('order calculations', () => {
  it('calculates geometric area and preserves manual cost', () => {
    const detail = createDetail();

    expect(calculateDetailArea(detail)).toBe(0.22);
    expect(calculateDetailCost(detail, 0.22)).toBe(10000);
  });

  it('rounds geometric area to the nearest hundredth instead of always rounding up', () => {
    const detail = createDetail({ height: 1055, width: 95, quantity: 1 });

    // Exact geometry is 0.100225 m²: standard two-decimal rounding is 0.10,
    // while the retired ROUNDUP formula produced 0.11.
    expect(calculateDetailArea(detail)).toBe(0.1);
  });

  it('rounds an exact half-cent boundary up like Excel ROUND', () => {
    const detail = createDetail({ height: 10075, width: 1000, quantity: 1 });

    expect(calculateDetailArea(detail)).toBe(10.08);
    expect(calculateDetailArea(createDetail({ height: 73.6, width: 1562.5, quantity: 1 }))).toBe(0.12);
  });

  it('sums raw geometry and rounds the order total only once', () => {
    const details = calculateOrderDetails([
      createDetail({ height: 50, width: 100, quantity: 1 }),
      createDetail({ height: 50, width: 100, quantity: 1 }),
    ]);
    const totals = calculateOrderTotals({
      header: { discount: 0, surcharge: 0, paymentStatusId: null },
      details,
      payments: [],
    });

    expect(details.map((detail) => detail.area)).toEqual([0.01, 0.01]);
    expect(totals.totalArea).toBe(0.01);
  });

  it('sums standard-rounded detail areas without the former per-row uplift', () => {
    const details = calculateOrderDetails([
      createDetail({ height: 1055, width: 95, quantity: 1 }),
      createDetail({ height: 614, width: 1011, quantity: 1 }),
    ]);
    const totals = calculateOrderTotals({
      header: { discount: 0, surcharge: 0, paymentStatusId: null },
      details,
      payments: [],
    });

    expect(details.map((detail) => detail.area)).toEqual([0.1, 0.62]);
    expect(totals.totalArea).toBe(0.72);
  });

  it('calculates detail cost from milling cost when manual cost is absent', () => {
    expect(
      calculateDetailCost(
        createDetail({
          detailCost: null,
          millingCostPerSqm: 123.456,
        }),
        2.25,
      ),
    ).toBe(277.78);
  });

  it('renumbers details by provided detailNumber, id, then original order', () => {
    const details = calculateOrderDetails([
      createDetail({ id: 2, detailNumber: 20 }),
      createDetail({ id: 1, detailNumber: 20 }),
      createDetail({ detailNumber: 10 }),
    ]);

    expect(details.map((detail) => detail.id)).toEqual([undefined, 1, 2]);
    expect(details.map((detail) => detail.detailNumber)).toEqual([1, 2, 3]);
  });

  it('calculates totals, latest payment date and partial status', () => {
    const totals = calculateOrderTotals({
      header: {
        discount: 1000,
        surcharge: 0,
        paymentStatusId: null,
      },
      details: calculateOrderDetails([createDetail({ detailCost: 10000, quantity: 3 })]),
      payments: [
        { amount: 2000, paymentDate: '2026-04-29', notes: null, refKey1c: null, typePaidId: 1 },
        { amount: 3000, paymentDate: '2026-04-30', notes: null, refKey1c: null, typePaidId: 1 },
      ],
    });

    expect(totals).toMatchObject({
      positionsCount: 1,
      partsCount: 3,
      totalAmount: 10000,
      finalAmount: 9000,
      paidAmount: 5000,
      debtAmount: 4000,
      paymentDate: '2026-04-30',
      paymentStatusId: 2,
    });
  });

  it('allows overpayment and keeps custom payment status ids', () => {
    const totals = calculateOrderTotals({
      header: {
        discount: 0,
        surcharge: 0,
        paymentStatusId: 4,
      },
      details: calculateOrderDetails([createDetail({ detailCost: 9500 })]),
      payments: [{ amount: 10000, paymentDate: '2026-04-30', notes: null, refKey1c: null, typePaidId: 1 }],
    });

    expect(totals.debtAmount).toBe(-500);
    expect(totals.paymentStatusId).toBe(4);
    expect(calculatePaymentStatusId(1, 9500, 10000)).toBe(3);
  });

  it('rejects negative final amount', () => {
    expect(() =>
      calculateOrderTotals({
        header: {
          discount: 100,
          surcharge: 0,
          paymentStatusId: null,
        },
        details: [],
        payments: [],
      }),
    ).toThrow(OrderFinalAmountNegativeError);
  });
});

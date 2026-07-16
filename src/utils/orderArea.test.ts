import { describe, expect, it } from 'vitest';
import { calculateOrderDetailArea, calculateOrderTotalArea } from './orderArea';

describe('calculateOrderDetailArea', () => {
  it('rounds exact geometry to the nearest hundredth', () => {
    expect(calculateOrderDetailArea(1055, 95, 1)).toBe(0.1);
    expect(calculateOrderDetailArea(614, 1011, 1)).toBe(0.62);
    expect(calculateOrderDetailArea(550, 200, 2)).toBe(0.22);
  });

  it('rounds an exact half-cent boundary up like Excel ROUND', () => {
    expect(calculateOrderDetailArea(10075, 1000, 1)).toBe(10.08);
    expect(calculateOrderDetailArea(73.6, 1562.5, 1)).toBe(0.12);
  });

  it('sums raw geometry and rounds the order total only once', () => {
    const details = [
      { height: 50, width: 100, quantity: 1 },
      { height: 50, width: 100, quantity: 1 },
    ];

    expect(details.map((detail) => calculateOrderDetailArea(detail.height, detail.width, detail.quantity))).toEqual([0.01, 0.01]);
    expect(calculateOrderTotalArea(details)).toBe(0.01);
  });

  it('returns zero for invalid dimensions or quantity', () => {
    expect(calculateOrderDetailArea(0, 100, 1)).toBe(0);
    expect(calculateOrderDetailArea(100, 100, 0)).toBe(0);
    expect(calculateOrderDetailArea(Number.NaN, 100, 1)).toBe(0);
  });
});

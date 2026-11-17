import { describe, expect, it } from 'vitest';
import { isRecommendedOrderNumber } from './orderNumberHint';

describe('recommended order number', () => {
  it('is only digits, at least 4', () => {
    for (const value of ['3160', ' 3160 ', '12345']) expect(isRecommendedOrderNumber(value)).toBe(true);
    for (const value of ['316', '3160-1', 'К51', '3160 1', '', null, undefined]) expect(isRecommendedOrderNumber(value)).toBe(false);
  });
});

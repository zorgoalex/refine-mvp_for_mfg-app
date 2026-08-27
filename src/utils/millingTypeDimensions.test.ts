import { describe, expect, it } from 'vitest';
import { millingTypeDimensionWarning, millingTypeFitsDetail } from './millingTypeDimensions';

const option = (overrides: Record<string, unknown> = {}) => ({
  value: 1,
  label: 'Тест фрезеровка',
  minWidthMm: null,
  minHeightMm: null,
  ...overrides,
});

describe('milling type minimum dimensions', () => {
  it('allows an unrestricted type for any detail dimensions', () => {
    expect(millingTypeFitsDetail(option(), null, null)).toBe(true);
  });

  it('requires every configured dimension to be present and large enough', () => {
    const constrained = option({ minWidthMm: 300, minHeightMm: 500 });
    expect(millingTypeFitsDetail(constrained, 300, 500)).toBe(true);
    expect(millingTypeFitsDetail(constrained, 299, 500)).toBe(false);
    expect(millingTypeFitsDetail(constrained, 300, 499)).toBe(false);
    expect(millingTypeFitsDetail(constrained, null, 500)).toBe(false);
  });

  it('returns a non-blocking warning for an unsuitable selected type', () => {
    expect(millingTypeDimensionWarning(
      option({ minWidthMm: 300, minHeightMm: 500 }),
      200,
      500,
    )).toBe('Возможна проблема с фрезеровкой: минимум 300 × 500 мм, размер детали 200 × 500 мм.');
    expect(millingTypeDimensionWarning(option({ minWidthMm: 100 }), 200, 500)).toBeNull();
  });

  it('warns while required detail dimensions are incomplete without blocking input', () => {
    expect(millingTypeDimensionWarning(
      option({ minWidthMm: 300 }),
      null,
      500,
    )).toContain('размеры детали заполнены не полностью');
  });
});

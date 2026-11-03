import { describe, expect, it } from 'vitest';
import { referenceUrlScalar } from './dataProvider';

describe('referenceUrlScalar', () => {
  it('types back URL strings of reference filters', () => {
    expect(referenceUrlScalar('is_active', 'in', 'false')).toBe(false);
    expect(referenceUrlScalar('is_active', 'eq', 'true')).toBe(true);
    expect(referenceUrlScalar('affects_stock', 'eq', 'false')).toBe(false);
    expect(referenceUrlScalar('requires_document', 'eq', 'true')).toBe(true);
    expect(referenceUrlScalar('is_cuttable', 'eq', 'true')).toBe(true);
    expect(referenceUrlScalar('workshop_id', 'eq', '12')).toBe(12);
    expect(referenceUrlScalar('sort_order', 'eq', '3')).toBe(3);
    expect(referenceUrlScalar('price', 'gte', '1500.5')).toBe(1500.5);
    // Column header filters (`in`) of boolean / number columns, back from the URL.
    expect(referenceUrlScalar('texture', 'in', 'false')).toBe(false);
    expect(referenceUrlScalar('thickness_mm', 'in', '18')).toBe(18);
    expect(referenceUrlScalar('decimals', 'in', '0')).toBe(0);
    expect(referenceUrlScalar('cost_per_sqm', 'in', '12.5')).toBe(12.5);
    expect(referenceUrlScalar('sequence_order', 'in', '2')).toBe(2);
  });

  it('keeps text values as they are', () => {
    expect(referenceUrlScalar('name', 'contains', '%123%')).toBe('%123%');
    expect(referenceUrlScalar('ref_key_1c', 'eq', '123')).toBe('123');
    expect(referenceUrlScalar('unit_code', 'in', '796')).toBe('796');
    expect(referenceUrlScalar('phone', 'in', '87010000000')).toBe('87010000000');
    expect(referenceUrlScalar('workshop_id', 'eq', 'abc')).toBe('abc');
    expect(referenceUrlScalar('is_active', 'eq', true)).toBe(true);
  });
});

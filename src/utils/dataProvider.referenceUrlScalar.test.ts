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
  });

  it('keeps text values as they are', () => {
    expect(referenceUrlScalar('name', 'contains', '%123%')).toBe('%123%');
    expect(referenceUrlScalar('ref_key_1c', 'eq', '123')).toBe('123');
    expect(referenceUrlScalar('workshop_id', 'eq', 'abc')).toBe('abc');
    expect(referenceUrlScalar('is_active', 'eq', true)).toBe(true);
  });
});

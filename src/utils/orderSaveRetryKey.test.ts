import { describe, expect, it, vi } from 'vitest';
import { orderSaveRetryKey } from './orderSaveRetryKey';

describe('order save frozen retry key', () => {
  const payload = { details: [], catalogLines: [{ id: 7, quantity: '1', unitPrice: '10.00', notes: '' }], deletedCatalogLineIds: [] };
  it('keeps an unchanged failed/ambiguous attempt key', () => {
    const create = vi.fn(() => 'new');
    expect(orderSaveRetryKey('frozen', JSON.stringify(payload), JSON.stringify(structuredClone(payload)), create)).toBe('frozen');
    expect(create).not.toHaveBeenCalled();
  });
  it.each([
    { ...payload, catalogLines: [{ ...payload.catalogLines[0], quantity: '2' }] },
    { ...payload, catalogLines: [{ ...payload.catalogLines[0], unitPrice: '20.00' }] },
    { ...payload, catalogLines: [], deletedCatalogLineIds: [7] },
  ])('allocates a new key for catalogue-only payload changes', next => {
    expect(orderSaveRetryKey('frozen', JSON.stringify(payload), JSON.stringify(next), () => 'fresh')).toBe('fresh');
  });
});

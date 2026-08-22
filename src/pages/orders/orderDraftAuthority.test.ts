import { describe, expect, it } from 'vitest';
import { isAuthoritativeDirtyOrderDraft } from './orderDraftAuthority';

describe('order draft authority', () => {
  it('preserves only a dirty draft owned by the opened order', () => {
    expect(isAuthoritativeDirtyOrderDraft({
      isDirty: true,
      header: { order_id: 42 },
    }, 42)).toBe(true);

    expect(isAuthoritativeDirtyOrderDraft({
      isDirty: true,
      header: {},
    }, 42)).toBe(false);

    expect(isAuthoritativeDirtyOrderDraft({
      isDirty: true,
      header: { order_id: 41 },
    }, 42)).toBe(false);

    expect(isAuthoritativeDirtyOrderDraft({
      isDirty: false,
      header: { order_id: 42 },
    }, 42)).toBe(false);
  });
});

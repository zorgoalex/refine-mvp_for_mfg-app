import { describe, expect, it } from 'vitest';
import { removeBackendStageOverridesForOrder } from './useProductionStatusEvent';

describe('useProductionStatusEvent backend stage overrides', () => {
  it('clears conflict recovery overrides only for the affected order', () => {
    const overrides = {
      '15:2': { active: true, eventId: 100 },
      '16:2': { active: true, eventId: 101 },
    };

    expect(removeBackendStageOverridesForOrder(overrides, 16)).toEqual({
      '15:2': { active: true, eventId: 100 },
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  applyBackendStageOverrides,
  removeBackendStageOverridesForOrder,
} from './useProductionStatusEvent';

describe('useProductionStatusEvent backend stage overrides', () => {
  it('applies optimistic activation and deactivation to the shared effective events', () => {
    const sourceEvents = [{
      event_id: 10,
      order_id: 15,
      detail_id: null,
      production_status_id: 1,
      event_at: '2026-08-21T00:00:00.000Z',
      payload: {},
    }];

    const activated = applyBackendStageOverrides(sourceEvents, {
      '15:2': { active: true, eventId: 11 },
    }, 15);
    expect(activated.map((event) => event.production_status_id)).toEqual([1, 2]);

    const deactivated = applyBackendStageOverrides(activated, {
      '15:1': { active: false },
    }, 15);
    expect(deactivated.map((event) => event.production_status_id)).toEqual([2]);
  });

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

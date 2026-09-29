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

describe('legacy Hasura stage-event writes after production rounds', () => {
  it('never treats a revoked Hasura mutation as success', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./useProductionStatusEvent.ts', import.meta.url), 'utf8');
    const branches = source.split("errorMsg.includes('not found in type')").slice(1);
    expect(branches).toHaveLength(3);
    for (const branch of branches) {
      const body = branch.slice(0, branch.indexOf('}'));
      expect(body).toContain('throw legacyStageWriteUnsupportedError(error)');
      expect(body).not.toMatch(/return( true)?;/);
    }
  });

  it('explains that stage marks go through the backend', async () => {
    const { legacyStageWriteUnsupportedError, LEGACY_STAGE_WRITE_UNSUPPORTED_MESSAGE } = await import('./useProductionStatusEvent');
    const cause = new Error('field "insert_production_status_events_one" not found in type: mutation_root');
    const error = legacyStageWriteUnsupportedError(cause);
    expect(error.message).toBe(LEGACY_STAGE_WRITE_UNSUPPORTED_MESSAGE);
    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
  });
});

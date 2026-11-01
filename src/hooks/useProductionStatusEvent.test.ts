import { describe, expect, it } from 'vitest';
import {
  applyBackendStageOverrides,
  isOverrideSettled,
  isStaleCommandAnswer,
  knownRoundOf,
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

  it('«Переделка»: an override made in an earlier production round does not apply once the order is in another round', () => {
    // Another user opened round 2 before the round-1 command was confirmed: the loaded marks are round 2's.
    const round2 = [{
      event_id: 20, order_id: 15, detail_id: null, production_status_id: 1, event_at: '2026-10-28T00:00:00.000Z', payload: {}, round_no: 2,
    }];
    const overrides = { '15:7': { active: true, eventId: 99, round: 1 } };
    expect(knownRoundOf(round2, 15)).toBe(2);
    expect(applyBackendStageOverrides(round2, overrides, 15, (id) => knownRoundOf(round2, id))
      .map((event) => event.production_status_id)).toEqual([1]);
    // In its own round it still applies (optimistic state until the refetch confirms it).
    expect(applyBackendStageOverrides(round2, { '15:7': { active: true, eventId: 99, round: 2 } }, 15, (id) => knownRoundOf(round2, id))
      .map((event) => event.production_status_id)).toEqual([1, 7]);
  });

  it('«Переделка»: a late command answer of round 1 is not shown once the loaded marks are round 2', () => {
    expect(isStaleCommandAnswer(1, 2)).toBe(true);
    expect(isStaleCommandAnswer(2, 2)).toBe(false);
    expect(isStaleCommandAnswer(undefined, 2)).toBe(false); // an old backend answer without the round
    expect(isStaleCommandAnswer(1, undefined)).toBe(false); // no marks loaded: decided by the next load
  });

  it('«Переделка»: an override ends with marks of another round, or with marks loaded after the command (an empty new round too)', () => {
    const override = { active: true, round: 1, at: 1_000 };
    // Still waiting: same round, marks loaded before the answer, mark not there yet.
    expect(isOverrideSettled(override, { sourceHasEvent: false, dataRound: 1, dataUpdatedAt: 900 })).toBe(false);
    // Confirmed by the marks.
    expect(isOverrideSettled(override, { sourceHasEvent: true, dataRound: 1, dataUpdatedAt: 900 })).toBe(true);
    // The order moved to round 2 (marks of round 2 loaded).
    expect(isOverrideSettled(override, { sourceHasEvent: false, dataRound: 2, dataUpdatedAt: 900 })).toBe(true);
    // The new round has no marks at all (Hasura shows the current round only → []): loaded after the answer.
    expect(isOverrideSettled(override, { sourceHasEvent: false, dataRound: undefined, dataUpdatedAt: 1_500 })).toBe(true);
  });
});

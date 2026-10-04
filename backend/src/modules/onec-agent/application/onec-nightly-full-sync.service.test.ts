import { describe, expect, it } from 'vitest';
import { latestClosedSlot, latestSlot, nightlyIdempotencyKey, nightlySlot } from './onec-nightly-full-sync.service';

describe('nightly full sync slot', () => {
  const at = (iso: string) => new Date(iso);

  it('belongs to the latest slot hour within four hours; outside the window there is no slot', () => {
    expect(nightlySlot(at('2026-10-02T20:59:59Z'), 21)).toBeNull();
    expect(nightlySlot(at('2026-10-02T21:00:00Z'), 21)).toMatchObject({ date: '2026-10-02' });
    expect(nightlySlot(at('2026-10-03T00:59:59Z'), 21)).toMatchObject({ date: '2026-10-02' });
    expect(nightlySlot(at('2026-10-03T01:00:00Z'), 21)).toBeNull();
    expect(nightlySlot(at('2026-10-03T12:00:00Z'), 21)).toBeNull();
  });

  it('crosses month and year boundaries and hour 0', () => {
    expect(nightlySlot(at('2026-11-01T00:30:00Z'), 21)).toMatchObject({ date: '2026-10-31' });
    expect(nightlySlot(at('2027-01-01T00:30:00Z'), 21)).toMatchObject({ date: '2026-12-31' });
    expect(nightlySlot(at('2026-10-02T00:00:00Z'), 0)).toMatchObject({ date: '2026-10-02' });
    expect(nightlySlot(at('2026-10-01T23:59:00Z'), 0)).toBeNull();
  });

  it('expires at the end of the window (latest start 06:00 Almaty) and is stable within the slot', () => {
    const first = nightlySlot(at('2026-10-02T21:00:00Z'), 21)!;
    const later = nightlySlot(at('2026-10-03T00:35:12Z'), 21)!;
    expect(later).toEqual(first);
    expect(first.startsAt.toISOString()).toBe('2026-10-02T21:00:00.000Z');
    expect(first.expiresAt.toISOString()).toBe('2026-10-03T01:00:00.000Z');
    expect(nightlyIdempotencyKey('unf-kz-test-01', first)).toBe('onec-nightly-full-sync:unf-kz-test-01:2026-10-02');
  });

  it('latest slot outside the window is the last night (for the missed-night check)', () => {
    expect(latestSlot(at('2026-10-03T12:00:00Z'), 21)).toMatchObject({ date: '2026-10-02' });
    expect(latestSlot(at('2026-10-02T20:00:00Z'), 21)).toMatchObject({ date: '2026-10-01' });
  });

  it('latest closed slot: inside a window it is the previous night, after the deadline it is the current one', () => {
    expect(latestClosedSlot(at('2026-10-02T21:30:00Z'), 21)).toMatchObject({ date: '2026-10-01' });
    expect(latestClosedSlot(at('2026-10-03T00:59:59Z'), 21)).toMatchObject({ date: '2026-10-01' });
    expect(latestClosedSlot(at('2026-10-03T01:00:00Z'), 21)).toMatchObject({ date: '2026-10-02' });
    expect(latestClosedSlot(at('2026-10-03T12:00:00Z'), 21).expiresAt.toISOString()).toBe('2026-10-03T01:00:00.000Z');
  });
});


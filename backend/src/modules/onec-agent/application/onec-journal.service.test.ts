import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JOURNAL_WINDOW_MS, stateDurations, stateTransitions } from './onec-journal.service';

describe('1C daily journal', () => {
  it('collapses consecutive equal states into transitions', () => {
    const rows = [
      { at: '2026-10-02T00:00:00Z', state: 'healthy', state_reason: null },
      { at: '2026-10-02T00:10:00Z', state: 'healthy', state_reason: null },
      { at: '2026-10-02T00:20:00Z', state: 'degraded', state_reason: 'ETL_RUNS_UNRESOLVED' },
      { at: '2026-10-02T00:30:00Z', state: 'degraded', state_reason: 'ETL_RUNS_UNRESOLVED' },
      { at: '2026-10-02T00:40:00Z', state: 'degraded', state_reason: 'OTHER' },
      { at: '2026-10-02T00:50:00Z', state: 'healthy', state_reason: null },
    ];
    expect(stateTransitions(rows).map((t) => [t.at.slice(11, 16), t.state, t.reason])).toEqual([
      ['00:00', 'healthy', null], ['00:20', 'degraded', 'ETL_RUNS_UNRESOLVED'], ['00:40', 'degraded', 'OTHER'], ['00:50', 'healthy', null],
    ]);
  });

  it('time in states: a record covers until the next one but at most 20 min; the rest is no_contact', () => {
    const from = new Date('2026-10-02T00:00:00Z');
    const to = new Date('2026-10-02T02:00:00Z');
    const rows = [
      { at: '2026-10-02T00:00:00Z', state: 'healthy' },
      { at: '2026-10-02T00:10:00Z', state: 'healthy' },
      { at: '2026-10-02T00:15:00Z', state: 'degraded' },
      // 00:15 + 20 min = 00:35; silent until 01:30
      { at: '2026-10-02T01:30:00Z', state: 'healthy' },
    ];
    const min = (state: string) => (stateDurations(rows, from, to).find((s) => s.state === state)?.ms ?? 0) / 60_000;
    expect(min('healthy')).toBe(10 + 5 + 20);
    expect(min('degraded')).toBe(20);
    expect(min('no_contact')).toBe(120 - 35 - 20);
    expect(stateDurations([], from, to)).toEqual([{ state: 'no_contact', ms: 120 * 60_000 }]);
    // A record before the window counts only inside it.
    expect(stateDurations([{ at: '2026-10-01T23:55:00Z', state: 'healthy' }], from, to).find((s) => s.state === 'healthy')?.ms).toBe(15 * 60_000);
  });

  it('window is 24 h; connection logs are kept 25 h, the run journal stays 90 days (replay safety)', () => {
    expect(JOURNAL_WINDOW_MS).toBe(24 * 60 * 60_000);
    const repository = readFileSync(new URL('../adapters/pg-onec-repository.ts', import.meta.url), 'utf8');
    expect(repository).toContain("DELETE FROM onec_agent_sessions WHERE last_seen_at < now() - interval '25 hours'");
    expect(repository).toContain("DELETE FROM onec_agent_status_history WHERE at < now() - interval '25 hours'");
    const etl = readFileSync(new URL('../domain/onec-etl.ts', import.meta.url), 'utf8');
    expect(etl).toMatch(/journalRetentionDays: 90,/);
  });

  it('the journal repository only reads; window edges: stored batches by stored_at, commands also by result time', () => {
    const source = readFileSync(new URL('../adapters/pg-onec-journal-repository.ts', import.meta.url), 'utf8');
    expect(source).toContain('(stored_at >= $2 OR (stored_at IS NULL AND received_at >= $2))');
    expect(source).toContain('(created_at >= $2 OR result_received_at >= $2)');
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});

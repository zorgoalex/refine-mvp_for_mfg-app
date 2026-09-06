import { describe, expect, it, vi } from 'vitest';
import { PgCncTelegramRepository } from './pg-cnc-telegram-repository';
import { parseTodayQuery } from '../http/cnc-telegram.controller';
import { mdfOperationalMonthStart } from '../application/mdf-operational-window';

function bathRow(readinessOnly: boolean) {
  return {
    cut_result_id: 9, cut_job_id: 3, result_no: 1, revision_no: 1,
    source_display_number: 'В-3', result_created_at: '2026-07-25T12:00:00Z',
    cut_job_name: 'E2E-Тест ванны', forced_bath_seed: true, hidden_bath_seed: false,
    order_id: 5, order_detail_id: 7, order_name: 'E2E-Тест', detail_number: 1,
    width_mm: 10, height_mm: 20, completed_quantity: 2,
    laminated_or_later: true, packed_or_later: true,
    cut_group_id: readinessOnly ? null : 8, variant: 'auto', sheet_index: 0,
    sheet_ordinal: 1, sheet_width_mm: 100, sheet_height_mm: 200,
    readiness_only: readinessOnly,
  };
}

describe('MDF operational month', () => {
  it('uses 31 inclusive business dates across leap/month boundaries', () => {
    expect(mdfOperationalMonthStart('2026-09-06')).toBe('2026-08-07');
    expect(mdfOperationalMonthStart('2024-03-01')).toBe('2024-01-31');
    expect(mdfOperationalMonthStart('2026-01-01')).toBe('2025-12-02');
  });

  it('validates the opt-in and focused bath without changing legacy parsing', () => {
    expect(parseTodayQuery({ date: '2026-09-06' })).toEqual({
      workday: '2026-09-06', workdayFrom: null, workdayTo: null,
    });
    expect(parseTodayQuery({ operationalWindow: 'month', focusBathCardId: 'cut-result:9' }))
      .toMatchObject({ operationalWindow: 'month', focusBathCardId: 'cut-result:9' });
    for (const query of [
      { operationalWindow: 'year' }, { focusBathCardId: 'cut-result:9' },
      { operationalWindow: 'month', focusBathCardId: 'cut-result:0' },
      { operationalWindow: 'month', focusBathCardId: 'cut-result:9999999999999999' },
      { operationalWindow: 'month', focusBathCardId: ['cut-result:9'] },
    ]) expect(() => parseTodayQuery(query)).toThrow();
  });

  it('separates old completion facts from cards and clamps only operational queries', async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: sql.includes('WITH laminated_status_threshold')
        ? [bathRow(true), bathRow(true)] : [] };
    });
    const repo = new PgCncTelegramRepository({ query } as never);
    const response = await repo.listToday({ currentUser: {} as never,
      workdayFrom: '2026-07-01', workdayTo: '2026-09-06', operationalWindow: 'month' });
    expect(calls.every((call) => call.params[0] === '2026-08-07')).toBe(true);
    expect(response.columns.flatMap((column) => column.baths)).toEqual([]);
    expect(response.operationalWindow).toEqual({ dateFrom: '2026-08-07', dateTo: '2026-09-06' });
    expect(response.historicalBathReadiness).toEqual([{
      bathCardId: 'cut-result:9', forced: true,
      items: [{ orderId: 5, orderName: 'E2E-Тест', detailId: 7, detailNumber: 1, quantity: 2 }],
    }]);
    const sql = calls.find((call) => call.sql.includes('WITH laminated_status_threshold'))!.sql;
    expect(sql).not.toContain('snapshot_job');
    expect(sql).toContain('board_metadata.snapshot_digest = r.snapshot_digest');
    expect(sql.indexOf('operational_completion AS')).toBeGreaterThan(sql.indexOf('latest_vacuum_results AS'));
    expect(sql).toContain('COUNT(*) > 0 AND BOOL_AND(COALESCE(');
    expect(sql).toContain('detail.order_id = placement.order_id');
    expect(sql).toContain("IS DISTINCT FROM $3::text AS readiness_only");
  });

  it('keeps legacy responses and threads a focused result only into retention', async () => {
    const query = vi.fn(async (sql: string, _params: readonly unknown[] = []) => ({
      rows: sql.includes('WITH laminated_status_threshold') ? [bathRow(false)] : [],
    }));
    const repo = new PgCncTelegramRepository({ query } as never);
    const legacy = await repo.listToday({ currentUser: {} as never,
      workdayFrom: '2026-07-01', workdayTo: '2026-09-06' });
    expect(legacy.operationalWindow).toBeUndefined();
    expect(legacy.historicalBathReadiness).toBeUndefined();
    expect(legacy.columns.flatMap((column) => column.baths)).toHaveLength(1);
    expect(query.mock.calls[0][1]?.[0]).toBe('2026-07-01');
    await repo.listToday({ currentUser: {} as never, workday: '2026-09-06',
      operationalWindow: 'month', focusBathCardId: 'cut-result:9' });
    expect(query.mock.calls.some((call) => call[1]?.[2] === 'cut-result:9')).toBe(true);
  });
});

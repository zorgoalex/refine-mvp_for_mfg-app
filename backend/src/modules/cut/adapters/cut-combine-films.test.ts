import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { combineFilmsChangedOutboxKey, groupByCuttableKey, PgCutRepository } from './pg-cut-repository';
import type { SetCutJobCombineFilmsCommand } from '../application/cut-command.types';

const anyUser: CurrentUser = {
  id: '1',
  username: 'tester',
  role: 'operator',
  permissions: ['cut.view'],
} as CurrentUser;

// ─── combineFilmsChangedOutboxKey ────────────────────────────────────────────

describe('combineFilmsChangedOutboxKey', () => {
  it('is stable per (job, requestId)', () => {
    expect(combineFilmsChangedOutboxKey(9, 'req-1', 3)).toBe('cut_job.combine_films_changed:9:req-1');
  });
  it('falls back to the version when no requestId is supplied', () => {
    expect(combineFilmsChangedOutboxKey(9, undefined, 3)).toBe('cut_job.combine_films_changed:9:v3');
  });
});

// ─── groupByCuttableKey ──────────────────────────────────────────────────────

describe('groupByCuttableKey', () => {
  const row = (over: Partial<any> = {}) => ({
    cut_job_item_id: 1, order_detail_id: 10, order_id: 100, qty: 1,
    width_mm: 600, height_mm: 400, material_id: null,
    sheet_material_type_id: 5, film_id: 3, film_texture: false,
    smt_width_mm: 2800, smt_height_mm: 2070, ...over,
  });

  it('OFF: splits same-material/different-film details into separate groups', () => {
    const rows = [row({ film_id: 3 }), row({ order_detail_id: 11, film_id: 7 })];
    const groups = [...groupByCuttableKey(rows as any, false).values()];
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.filmId).sort()).toEqual([3, 7]);
    expect(groups.every((g) => g.sheetMaterialTypeId === 5)).toBe(true);
  });

  it('ON: merges same-material/different-film details into one group (filmId null)', () => {
    const rows = [row({ film_id: 3 }), row({ order_detail_id: 11, film_id: 7 })];
    const groups = [...groupByCuttableKey(rows as any, true).values()];
    expect(groups).toHaveLength(1);
    expect(groups[0].filmId).toBeNull();
    expect(groups[0].sheetMaterialTypeId).toBe(5);
    expect(groups[0].items).toHaveLength(2);
  });

  it('ON: NEVER merges different materials (one group per material)', () => {
    const rows = [row({ sheet_material_type_id: 5, film_id: 3 }), row({ order_detail_id: 11, sheet_material_type_id: 8, film_id: 7 })];
    const groups = [...groupByCuttableKey(rows as any, true).values()];
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.sheetMaterialTypeId).sort()).toEqual([5, 8]);
  });

  it('ON: keeps filmTexture per item so grain stays per-detail', () => {
    const rows = [row({ film_id: 3, film_texture: true }), row({ order_detail_id: 11, film_id: 7, film_texture: false })];
    const groups = [...groupByCuttableKey(rows as any, true).values()];
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.filmTexture).sort()).toEqual([false, true]);
  });
});

// ─── setCombineFilms unit tests ──────────────────────────────────────────────

function makeRepoForSetCombine(opts: {
  status: string;
  version: number;
  current: boolean;
}): PgCutRepository & { updateCalls: string[]; outboxCalls: string[]; auditCalls: string[] } {
  const updateCalls: string[] = [];
  const outboxCalls: string[] = [];
  const auditCalls: string[] = [];

  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

  const handle = (text: string, _params: readonly unknown[]) => {
    const sql = normalize(text);

    if (sql.startsWith('SELECT set_session_user')) return { rows: [], rowCount: 0 };

    // FOR UPDATE lock row (setCombineFilms's narrow SELECT)
    if (sql.startsWith('SELECT status, version, combine_films FROM cut_job')) {
      return { rows: [{ status: opts.status, version: opts.version, combine_films: opts.current }], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE cut_job SET combine_films')) {
      updateCalls.push(text);
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO audit_log_related_entity')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('INSERT INTO audit_log')) {
      auditCalls.push(text);
      return { rows: [{ audit_id: 'aud-1' }], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO outbox_events')) {
      outboxCalls.push(text);
      return { rows: [], rowCount: 1 };
    }

    // loadJob reads (after update)
    if (sql.startsWith('SELECT cut_job_id, name, status, source, version, pdf_prewarm_state, failure_code, failure_reason, param_profile_id, sheet_material_type_id, combine_films FROM cut_job')) {
      return { rows: [{ cut_job_id: 9, name: 'J', status: opts.status, source: 'manual', version: opts.version, pdf_prewarm_state: 'pending', failure_code: null, failure_reason: null, param_profile_id: null, sheet_material_type_id: null, combine_films: opts.current }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT i.cut_job_id')) return { rows: [{ cut_job_id: 9, positions: 0, details: 0, area: 0, materials_count: 0, films_count: 0 }], rowCount: 1 };
    if (sql.startsWith('SELECT g.cut_job_id')) return { rows: [{ cut_job_id: 9, sheets: 0 }], rowCount: 1 };
    if (sql.startsWith('SELECT cut_job_item_id, order_detail_id, order_id, qty, cut_group_id FROM cut_job_item')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT cut_group_id, sheet_material_type_id, film_id, status, summary FROM cut_group')) return { rows: [], rowCount: 0 };

    return { rows: [], rowCount: 0 };
  };

  const client = { query: (text: string, params: readonly unknown[] = []) => Promise.resolve(handle(text, params)) };
  const service = {
    query: (text: string, params: readonly unknown[] = []) => Promise.resolve(handle(text, params)),
    async transaction<T>(fn: (c: typeof client) => Promise<T>) { return fn(client); },
  } as unknown as DatabaseService;

  const freecutStub = { optimize: () => Promise.reject(new Error('not used')) } as never;
  const repo = new PgCutRepository(service, freecutStub) as PgCutRepository & { updateCalls: string[]; outboxCalls: string[]; auditCalls: string[] };
  repo.updateCalls = updateCalls;
  repo.outboxCalls = outboxCalls;
  repo.auditCalls = auditCalls;
  return repo;
}

describe('setCombineFilms', () => {
  it('no-ops when the value is unchanged (no version bump / no audit / no outbox)', async () => {
    const repo = makeRepoForSetCombine({ status: 'ready', version: 4, current: true });
    await repo.setCombineFilms({ currentUser: anyUser, cutJobId: 9, combineFilms: true, version: 4 } as SetCutJobCombineFilmsCommand);
    expect(repo.updateCalls).toHaveLength(0);
    expect(repo.outboxCalls).toHaveLength(0);
    expect(repo.auditCalls).toHaveLength(0);
  });

  it('rejects a stale version', async () => {
    const repo = makeRepoForSetCombine({ status: 'draft', version: 5, current: false });
    await expect(
      repo.setCombineFilms({ currentUser: anyUser, cutJobId: 9, combineFilms: true, version: 4 } as SetCutJobCombineFilmsCommand),
    ).rejects.toMatchObject({ code: 'CUT_STALE_VERSION' });
  });

  it('rejects a non-editable status', async () => {
    const repo = makeRepoForSetCombine({ status: 'calculating', version: 2, current: false });
    await expect(
      repo.setCombineFilms({ currentUser: anyUser, cutJobId: 9, combineFilms: true, version: 2 } as SetCutJobCombineFilmsCommand),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('on change (false -> true) writes exactly one UPDATE (+version bump), one audit, one outbox', async () => {
    const repo = makeRepoForSetCombine({ status: 'draft', version: 3, current: false });
    await repo.setCombineFilms({ currentUser: anyUser, cutJobId: 9, combineFilms: true, version: 3 } as SetCutJobCombineFilmsCommand);
    expect(repo.updateCalls).toHaveLength(1);
    expect(repo.updateCalls[0].replace(/\s+/g, ' ')).toContain('version = version + 1');
    expect(repo.auditCalls).toHaveLength(1);
    expect(repo.outboxCalls).toHaveLength(1);
  });
});

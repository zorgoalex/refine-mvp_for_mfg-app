import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { applySheetOverride, groupByCuttableKey, logicalGroupKey, splitByMaterialChangedOutboxKey, PgCutRepository } from './pg-cut-repository';
import type { SetCutJobSplitByMaterialCommand } from '../application/cut-command.types';

const anyUser: CurrentUser = {
  id: '1',
  username: 'tester',
  role: 'operator',
  permissions: ['cut.view'],
} as CurrentUser;

describe('splitByMaterialChangedOutboxKey', () => {
  it('is stable per (job, requestId), version fallback', () => {
    expect(splitByMaterialChangedOutboxKey(9, 'req-1', 3)).toBe('cut_job.split_by_material_changed:9:req-1');
    expect(splitByMaterialChangedOutboxKey(9, undefined, 3)).toBe('cut_job.split_by_material_changed:9:v3');
  });
});

describe('groupByCuttableKey splitByMaterial', () => {
  const row = (over: Partial<any> = {}) => ({
    cut_job_item_id: 1, order_detail_id: 10, order_id: 100, qty: 1,
    width_mm: 600, height_mm: 400, material_id: null,
    sheet_material_type_id: 2, film_id: 3, film_texture: false,
    smt_width_mm: 2800, smt_height_mm: 2070, ...over,
  });

  it('split=true: 3 different materials → 3 groups (never merged)', () => {
    const rows = [
      row({ sheet_material_type_id: 2 }),
      row({ order_detail_id: 11, sheet_material_type_id: 3 }),
      row({ order_detail_id: 12, sheet_material_type_id: 5 }),
    ];
    const groups = [...groupByCuttableKey(rows as any, false, true).values()];
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.sheetMaterialTypeId).sort()).toEqual([2, 3, 5]);
  });

  it('split=false + combineFilms=false: groups by film even when materials are not split', () => {
    const rows = [
      row({ sheet_material_type_id: 2, film_id: 3 }),
      row({ order_detail_id: 11, sheet_material_type_id: 3, film_id: 7 }),
      row({ order_detail_id: 12, sheet_material_type_id: 5, film_id: 7 }),
    ];
    const groups = [...groupByCuttableKey(rows as any, false, false).values()];
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.filmId).sort()).toEqual([3, 7]);
    expect(groups.find((g) => g.filmId === 7)?.items.map((item) => item.orderDetailId).sort()).toEqual([11, 12]);
  });

  it('split=false + combineFilms=true: combines every film into one all-details group', () => {
    const rows = [
      row({ sheet_material_type_id: 2, film_id: 3 }),
      row({ order_detail_id: 11, sheet_material_type_id: 3, film_id: 7 }),
      row({ order_detail_id: 12, sheet_material_type_id: 5, film_id: 9 }),
    ];
    const groups = [...groupByCuttableKey(rows as any, true, false).values()];
    expect(groups).toHaveLength(1);
    expect(groups[0].filmId).toBeNull();
    expect(groups[0].items).toHaveLength(3);
  });

  it('split=false: when the FIRST row is no_sheet_spec, the all-group adopts the first materialed sheet (not null → no CUT_NO_SHEET_SPEC)', () => {
    const rows = [
      row({ order_detail_id: 10, sheet_material_type_id: null, smt_width_mm: null, smt_height_mm: null }),
      row({ order_detail_id: 11, sheet_material_type_id: 5, smt_width_mm: 2440, smt_height_mm: 1830 }),
    ];
    const groups = [...groupByCuttableKey(rows as any, false, false).values()];
    expect(groups).toHaveLength(1);
    expect(groups[0].sheetMaterialTypeId).toBe(5);
    expect(groups[0].smtWidthMm).toBe(2440);
    expect(groups[0].smtHeightMm).toBe(1830);
    expect(groups[0].items).toHaveLength(2);
  });

  it('split=true + combineFilms: per material, films merged within each material', () => {
    const rows = [
      row({ sheet_material_type_id: 2, film_id: 3 }),
      row({ order_detail_id: 11, sheet_material_type_id: 2, film_id: 7 }),
      row({ order_detail_id: 12, sheet_material_type_id: 3, film_id: 7 }),
    ];
    const groups = [...groupByCuttableKey(rows as any, true, true).values()];
    expect(groups).toHaveLength(2); // material 2 (films merged) + material 3
    expect(groups.map((g) => g.sheetMaterialTypeId).sort()).toEqual([2, 3]);
    expect(groups.every((g) => g.filmId === null)).toBe(true);
  });

  it('logical group key preserves film identity when only material split is off', () => {
    expect(logicalGroupKey({ splitByMaterial: false, combineFilms: false, sheetMaterialTypeId: 7, filmId: 3 })).toBe('all|f:3');
    expect(logicalGroupKey({ splitByMaterial: false, combineFilms: true, sheetMaterialTypeId: 7, filmId: 3 })).toBe('all');
  });
});

describe('applySheetOverride onlyNoSheetSpec', () => {
  const base = (over: Partial<any> = {}) => ({
    cut_job_item_id: 1, order_detail_id: 10, order_id: 100, qty: 1,
    width_mm: 600, height_mm: 400, material_id: null,
    sheet_material_type_id: 2, film_id: 3, film_texture: false,
    smt_width_mm: 2800, smt_height_mm: 2070, ...over,
  });

  it('onlyNoSheetSpec: leaves materialed rows untouched, fills only no-sheet rows', () => {
    const rows = [base({ sheet_material_type_id: 2 }), base({ order_detail_id: 11, sheet_material_type_id: null, smt_width_mm: null, smt_height_mm: null })];
    const out = applySheetOverride(rows as any, { sheetMaterialTypeId: 9, widthMm: 2440, heightMm: 1830 }, { onlyNoSheetSpec: true });
    expect(out[0].sheet_material_type_id).toBe(2); // materialed row untouched
    expect(out[1].sheet_material_type_id).toBe(9); // no-sheet row filled
    expect(out[1].smt_width_mm).toBe(2440);
  });

  it('default (no option): rewrites every row (the !split / cram case)', () => {
    const rows = [base({ sheet_material_type_id: 2 }), base({ order_detail_id: 11, sheet_material_type_id: 5 })];
    const out = applySheetOverride(rows as any, { sheetMaterialTypeId: 9, widthMm: 2440, heightMm: 1830 });
    expect(out.every((r) => r.sheet_material_type_id === 9)).toBe(true);
  });
});

// ─── setSplitByMaterial unit tests ───────────────────────────────────────────

function makeRepo(opts: { status: string; version: number; current: boolean }): PgCutRepository & { updateCalls: string[]; outboxCalls: string[]; auditCalls: string[] } {
  const updateCalls: string[] = [];
  const outboxCalls: string[] = [];
  const auditCalls: string[] = [];
  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

  const handle = (text: string, _params: readonly unknown[]) => {
    const sql = normalize(text);
    if (sql.startsWith('SELECT set_session_user')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT status, version, split_by_material FROM cut_job')) {
      return { rows: [{ status: opts.status, version: opts.version, split_by_material: opts.current }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE cut_job SET split_by_material')) {
      updateCalls.push(text);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO audit_log_related_entity')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('INSERT INTO audit_log')) { auditCalls.push(text); return { rows: [{ audit_id: 'aud-1' }], rowCount: 1 }; }
    if (sql.startsWith('INSERT INTO outbox_events')) { outboxCalls.push(text); return { rows: [], rowCount: 1 }; }
    if (sql.startsWith('SELECT cut_job_id, name, status, source, version,')) {
      return { rows: [{ cut_job_id: 9, name: 'J', status: opts.status, source: 'manual', version: opts.version, pdf_prewarm_state: 'pending', failure_code: null, failure_reason: null, param_profile_id: null, sheet_material_type_id: null, combine_films: false, split_by_material: opts.current, last_calc_params: null }], rowCount: 1 };
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
  const repo = new PgCutRepository(service, { optimize: () => Promise.reject(new Error('not used')) } as never) as PgCutRepository & { updateCalls: string[]; outboxCalls: string[]; auditCalls: string[] };
  repo.updateCalls = updateCalls; repo.outboxCalls = outboxCalls; repo.auditCalls = auditCalls;
  return repo;
}

describe('setSplitByMaterial', () => {
  it('no-ops when unchanged (no version bump / audit / outbox)', async () => {
    const repo = makeRepo({ status: 'ready', version: 4, current: true });
    await repo.setSplitByMaterial({ currentUser: anyUser, cutJobId: 9, splitByMaterial: true, version: 4 } as SetCutJobSplitByMaterialCommand);
    expect(repo.updateCalls).toHaveLength(0);
    expect(repo.outboxCalls).toHaveLength(0);
    expect(repo.auditCalls).toHaveLength(0);
  });

  it('rejects a stale version', async () => {
    const repo = makeRepo({ status: 'draft', version: 5, current: true });
    await expect(
      repo.setSplitByMaterial({ currentUser: anyUser, cutJobId: 9, splitByMaterial: false, version: 4 } as SetCutJobSplitByMaterialCommand),
    ).rejects.toMatchObject({ code: 'CUT_STALE_VERSION' });
  });

  it('rejects a non-editable status', async () => {
    const repo = makeRepo({ status: 'calculating', version: 2, current: true });
    await expect(
      repo.setSplitByMaterial({ currentUser: anyUser, cutJobId: 9, splitByMaterial: false, version: 2 } as SetCutJobSplitByMaterialCommand),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('on change (true→false) writes one UPDATE (+version bump), one audit, one outbox', async () => {
    const repo = makeRepo({ status: 'draft', version: 3, current: true });
    await repo.setSplitByMaterial({ currentUser: anyUser, cutJobId: 9, splitByMaterial: false, version: 3 } as SetCutJobSplitByMaterialCommand);
    expect(repo.updateCalls).toHaveLength(1);
    expect(repo.updateCalls[0].replace(/\s+/g, ' ')).toContain('version = version + 1');
    expect(repo.auditCalls).toHaveLength(1);
    expect(repo.outboxCalls).toHaveLength(1);
  });
});

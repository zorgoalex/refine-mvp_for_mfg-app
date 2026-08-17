import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { CutSheetMaterialNotCuttableError } from '../errors/cut.errors';
import { CUT_AUDIT_EVENTS } from '../application/cut-audit';
import { sheetMaterialChangedOutboxKey, PgCutRepository, applySheetOverride } from './pg-cut-repository';
import type { SetCutJobSheetMaterialCommand } from '../application/cut-command.types';

const anyUser: CurrentUser = {
  id: '1',
  username: 'tester',
  role: 'operator',
  permissions: ['cut.view'],
} as CurrentUser;

/** Build a PgCutRepository whose database.query returns the given rows for any query. */
function makeRepoWithRows(rows: Record<string, unknown>[]): PgCutRepository {
  const service = {
    query: (_text: string, _params?: readonly unknown[]) => Promise.resolve({ rows, rowCount: rows.length }),
    transaction: async <T>(fn: (c: DatabaseService) => Promise<T>) => fn(service as unknown as DatabaseService),
  } as unknown as DatabaseService;
  // freecut is not used by listSheetTypesForCut; pass a minimal stub.
  const freecutStub = { optimize: () => Promise.reject(new Error('not used')) } as never;
  return new PgCutRepository(service, freecutStub);
}

describe('sheet-material override foundation', () => {
  it('error maps to 422 with stable code', () => {
    const e = new CutSheetMaterialNotCuttableError(42);
    expect(e.statusCode).toBe(422);
    expect(e.code).toBe('CUT_SHEET_MATERIAL_NOT_CUTTABLE');
    expect(e.details).toMatchObject({ sheetMaterialTypeId: 42 });
  });

  it('audit event name is stable', () => {
    expect(CUT_AUDIT_EVENTS.sheetMaterialChanged).toBe('cut_job.sheet_material_changed');
  });

  it('outbox key is stable per (job, request) and falls back to version', () => {
    expect(sheetMaterialChangedOutboxKey(7, 'req-1', 3)).toBe('cut_job.sheet_material_changed:7:req-1');
    expect(sheetMaterialChangedOutboxKey(7, undefined, 3)).toBe('cut_job.sheet_material_changed:7:v3');
  });
});

describe('listSheetTypesForCut', () => {
  it('returns materialTypeId and thicknessMm', async () => {
    const repo = makeRepoWithRows([
      { sheet_material_type_id: 1, name: 'ЛДСП 18 2800x2070', material_type_id: 5, thickness_mm: 18, width_mm: 2800, height_mm: 2070, is_cuttable: true },
    ]);
    const out = await repo.listSheetTypesForCut({ currentUser: anyUser });
    expect(out[0]).toMatchObject({
      sheetMaterialTypeId: 1,
      name: 'ЛДСП 18 2800x2070',
      materialTypeId: 5,
      thicknessMm: 18,
      widthMm: 2800,
      heightMm: 2070,
      isCuttable: true,
    });
  });
});

// ─── setSheetMaterial unit tests ─────────────────────────────────────────────

/**
 * Build a PgCutRepository with a transaction-fake that tracks UPDATE and
 * outbox INSERT calls separately, modelled after pg-cut-repository.test.ts.
 *
 * Options:
 *   status      - current cut_job row status
 *   version     - current cut_job row version
 *   current     - current sheet_material_type_id in the DB (null = not set)
 *   sheetExists - whether the sheet_material_types validation query returns a row
 */
function makeRepoForSetSheet(opts: {
  status: string;
  version: number;
  current: number | null;
  sheetExists: boolean;
}): PgCutRepository & { updateCalls: string[]; outboxCalls: string[]; auditCalls: string[] } {
  const updateCalls: string[] = [];
  const outboxCalls: string[] = [];
  const auditCalls: string[] = [];

  function normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  const handle = (text: string, _params: readonly unknown[]) => {
    const sql = normalize(text);

    if (sql.startsWith('SELECT set_session_user')) return { rows: [], rowCount: 0 };

    // FOR UPDATE lock row (setSheetMaterial's narrow SELECT)
    if (sql.startsWith('SELECT status, version, sheet_material_type_id FROM cut_job')) {
      return {
        rows: [{ status: opts.status, version: opts.version, sheet_material_type_id: opts.current }],
        rowCount: 1,
      };
    }

    // sheet_material_types cuttable/active validation
    if (sql.startsWith('SELECT 1 FROM sheet_material_types')) {
      return { rows: opts.sheetExists ? [{ '?column?': 1 }] : [], rowCount: opts.sheetExists ? 1 : 0 };
    }

    // UPDATE cut_job SET sheet_material_type_id
    if (sql.startsWith('UPDATE cut_job SET sheet_material_type_id')) {
      updateCalls.push(text);
      return { rows: [], rowCount: 1 };
    }

    // audit_log insert (the related-entity insert is a follow-on; count only the
    // primary audit_log write as one audit event)
    if (sql.startsWith('INSERT INTO audit_log_related_entity')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('INSERT INTO audit_log')) {
      auditCalls.push(text);
      return { rows: [{ audit_id: 'aud-1' }], rowCount: 1 };
    }

    // outbox insert
    if (sql.startsWith('INSERT INTO outbox_events')) {
      outboxCalls.push(text);
      return { rows: [], rowCount: 1 };
    }

    // loadJob reads (after update)
    if (sql.startsWith('SELECT j.cut_job_id, j.name, j.status, j.source, j.version,')) {
      return { rows: [{ cut_job_id: 9, name: 'J', status: opts.status, source: 'manual', created_at: new Date('2026-08-07T00:00:00Z'), version: opts.version, pdf_prewarm_state: 'pending', failure_code: null, failure_reason: null, param_profile_id: null, sheet_material_type_id: null, pdf_template_code: null, combine_films: false, split_by_material: true, rotation_allowed: true, texture_direction: 'none', last_calc_params: null }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT i.cut_job_id')) return { rows: [{ cut_job_id: 9, positions: 0, details: 0, area: 0 }], rowCount: 1 };
    if (sql.startsWith('SELECT g.cut_job_id')) return { rows: [{ cut_job_id: 9, sheets: 0 }], rowCount: 1 };
    if (sql.startsWith('SELECT i.cut_job_item_id, i.source_type, i.freecut_item_id')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT cg.cut_group_id,')) return { rows: [], rowCount: 0 };

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

// ─── applySheetOverride unit tests ───────────────────────────────────────────

describe('applySheetOverride', () => {
  const base = (over: Partial<any> = {}) => ({
    cut_job_item_id: 1, order_detail_id: 10, order_id: 100, qty: 2,
    width_mm: 600, height_mm: 400, material_id: null,
    sheet_material_type_id: 55, film_id: 3, film_texture: true,
    smt_width_mm: 2800, smt_height_mm: 2070, ...over,
  });

  it('overrides sheet id + dims on every row, including no_sheet_spec rows', () => {
    const rows = [base(), base({ sheet_material_type_id: null, smt_width_mm: null, smt_height_mm: null, film_id: 9 })];
    const out = applySheetOverride(rows as any, { sheetMaterialTypeId: 77, widthMm: 2440, heightMm: 1830 });
    expect(out.every((r) => r.sheet_material_type_id === 77)).toBe(true);
    expect(out.every((r) => r.smt_width_mm === 2440 && r.smt_height_mm === 1830)).toBe(true);
    // pure: returns NEW row objects, leaving the inputs untouched
    expect(out[0]).not.toBe(rows[0]);
    expect(rows[0].sheet_material_type_id).toBe(55);
    expect(rows[0].smt_width_mm).toBe(2800);
  });

  it('leaves film_id per-detail (grain grouping preserved)', () => {
    const rows = [base({ film_id: 3 }), base({ film_id: 9 })];
    const out = applySheetOverride(rows as any, { sheetMaterialTypeId: 77, widthMm: 2440, heightMm: 1830 });
    expect(out.map((r) => r.film_id)).toEqual([3, 9]);
  });
});

describe('setSheetMaterial', () => {
  it('rejects a non-cuttable/inactive sheet with 422', async () => {
    const repo = makeRepoForSetSheet({ status: 'draft', version: 2, current: null, sheetExists: false });
    await expect(
      repo.setSheetMaterial({ currentUser: anyUser, cutJobId: 9, sheetMaterialTypeId: 77, version: 2 } as SetCutJobSheetMaterialCommand),
    ).rejects.toMatchObject({ statusCode: 422, code: 'CUT_SHEET_MATERIAL_NOT_CUTTABLE' });
  });

  it('no-ops when the value is unchanged (no version bump / no audit / no outbox)', async () => {
    const repo = makeRepoForSetSheet({ status: 'ready', version: 4, current: 55, sheetExists: true });
    await repo.setSheetMaterial({ currentUser: anyUser, cutJobId: 9, sheetMaterialTypeId: 55, version: 4 } as SetCutJobSheetMaterialCommand);
    expect(repo.updateCalls).toHaveLength(0);
    expect(repo.outboxCalls).toHaveLength(0);
  });

  it('rejects a stale version', async () => {
    const repo = makeRepoForSetSheet({ status: 'draft', version: 5, current: null, sheetExists: true });
    await expect(
      repo.setSheetMaterial({ currentUser: anyUser, cutJobId: 9, sheetMaterialTypeId: 1, version: 4 } as SetCutJobSheetMaterialCommand),
    ).rejects.toMatchObject({ code: 'CUT_STALE_VERSION' });
  });

  it('on change (null -> 55) writes exactly one UPDATE (+version bump), one audit, one outbox', async () => {
    const repo = makeRepoForSetSheet({ status: 'draft', version: 3, current: null, sheetExists: true });
    await repo.setSheetMaterial({ currentUser: anyUser, cutJobId: 9, sheetMaterialTypeId: 55, version: 3 } as SetCutJobSheetMaterialCommand);
    expect(repo.updateCalls).toHaveLength(1);
    // the UPDATE both sets the column and bumps version in one statement
    expect(repo.updateCalls[0].replace(/\s+/g, ' ')).toContain('version = version + 1');
    expect(repo.auditCalls).toHaveLength(1);
    expect(repo.outboxCalls).toHaveLength(1);
  });
});

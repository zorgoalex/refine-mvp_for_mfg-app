import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type { FreecutClient } from './freecut-client';
import type { FreecutOptimizeResponse } from '../application/cut-freecut-mapping';
import type { CutConfigPort } from '../application/cut-config';
import { StaticCutConfig } from '../application/cut-config';
import { PgCutRepository, profileChangedOutboxKey } from './pg-cut-repository';

/** Build a CutConfigPort stub with selective overrides (defaults to StaticCutConfig). */
function stubConfig(overrides: Partial<CutConfigPort> = {}): CutConfigPort {
  const base = new StaticCutConfig();
  return {
    getReadyStatusCodes: base.getReadyStatusCodes.bind(base),
    getDefaultParams: base.getDefaultParams.bind(base),
    getGrainRules: base.getGrainRules.bind(base),
    getRenderPresetPx: base.getRenderPresetPx.bind(base),
    getParamsByProfileId: base.getParamsByProfileId.bind(base),
    ...overrides,
  };
}

function currentUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: '7',
    username: 'cutter',
    role: 'operator',
    permissions: ['cut.view', 'cut.manage'],
    ...overrides,
  } as CurrentUser;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

interface FakeRow {
  [key: string]: unknown;
}

interface FakeDbOptions {
  /** rows returned for `SELECT ... FROM order_details ... WHERE detail_id` (detail resolution) */
  detailRows?: Record<number, FakeRow>;
  /** rows returned for the FOR UPDATE cut_job load */
  cutJob?: FakeRow;
  /** rows for the active-items+specs join used by calculate */
  calcItems?: FakeRow[];
  /** ready-status id resolution */
  readyStatusIds?: number[];
  /** throw 23505 on the next cut_job_item insert */
  reserveConflict?: boolean;
  /** rows for listEligibleDetails */
  eligibleRows?: FakeRow[];
  /** whether the cut_param_profiles SELECT returns a row (profile is active) */
  profileActive?: boolean;
}

function createDatabase(options: FakeDbOptions = {}) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  let cutGroupSeq = 100;
  let itemSeq = 500;
  let jobVersion = (options.cutJob?.version as number | undefined) ?? 0;

  const handle = (text: string, params: readonly unknown[]) => {
    queries.push({ text, params });
    const sql = normalize(text);

    if (sql.startsWith('SELECT set_session_user')) return { rows: [], rowCount: 0 };

    if (sql.startsWith('INSERT INTO cut_job (')) {
      return { rows: [{ cut_job_id: 42 }], rowCount: 1 };
    }

    if (sql.startsWith('SELECT cut_job_id, name, status, source, version, pdf_prewarm_state, params, param_profile_id, sheet_material_type_id, combine_films, split_by_material FROM cut_job WHERE cut_job_id = $1 FOR UPDATE')) {
      const base = options.cutJob ?? { cut_job_id: 42, name: 'J', status: 'draft', source: 'manual', version: 0, pdf_prewarm_state: 'pending', params: null };
      return { rows: [{ ...base, version: jobVersion, param_profile_id: options.cutJob?.param_profile_id ?? null, sheet_material_type_id: options.cutJob?.sheet_material_type_id ?? null, combine_films: options.cutJob?.combine_films ?? false, split_by_material: options.cutJob?.split_by_material ?? true }], rowCount: 1 };
    }

    // setProfile FOR UPDATE: narrower column list (cut_job_id, status, version, param_profile_id)
    if (sql.startsWith('SELECT cut_job_id, status, version, param_profile_id FROM cut_job WHERE cut_job_id = $1 FOR UPDATE')) {
      const base = options.cutJob ?? { cut_job_id: 42, status: 'ready', version: 0, param_profile_id: null };
      return { rows: [{ cut_job_id: base.cut_job_id ?? 42, status: base.status ?? 'ready', version: jobVersion, param_profile_id: base.param_profile_id ?? null }], rowCount: 1 };
    }

    // profile active check
    if (sql.startsWith('SELECT 1 FROM cut_param_profiles WHERE cut_param_profile_id = $1 AND is_active = true')) {
      const active = options.profileActive !== false; // default true
      return { rows: active ? [{ '?column?': 1 }] : [], rowCount: active ? 1 : 0 };
    }

    if (sql.startsWith('SELECT od.order_id, od.quantity, od.production_status_id, od.delete_flag')) {
      const detailId = params[0] as number;
      const row = options.detailRows?.[detailId];
      if (!row) return { rows: [], rowCount: 0 };
      // Eligibility defaults: ready status (1 ∈ readyStatusIds) + linked sheet spec,
      // unless the test overrides them.
      return {
        rows: [
          {
            production_status_id: 1,
            delete_flag: false,
            sheet_material_type_id: 9,
            ...row,
          },
        ],
        rowCount: 1,
      };
    }

    if (sql.startsWith('INSERT INTO cut_job_item (')) {
      if (options.reserveConflict) {
        const error = new Error('duplicate key') as Error & { code?: string };
        error.code = '23505';
        throw error;
      }
      return { rows: [{ cut_job_item_id: ++itemSeq }], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE cut_job_item SET is_active = false')) {
      return { rows: [{ cut_job_item_id: params[0], order_id: 9, order_detail_id: 1 }], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE cut_job SET')) {
      if (sql.includes('version = version + 1')) jobVersion += 1;
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('SELECT cji.cut_job_item_id')) {
      return { rows: options.calcItems ?? [], rowCount: (options.calcItems ?? []).length };
    }

    if (sql.startsWith('SELECT production_status_id FROM production_statuses')) {
      const ids = options.readyStatusIds ?? [1, 2, 3];
      return { rows: ids.map((id) => ({ production_status_id: id })), rowCount: ids.length };
    }

    if (sql.startsWith('INSERT INTO cut_group (')) {
      return { rows: [{ cut_group_id: ++cutGroupSeq }], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO cut_group_sheet (')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('INSERT INTO outbox_events')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('INSERT INTO audit_log')) return { rows: [{ audit_id: 'aud-1' }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO audit_log_related_entity')) return { rows: [], rowCount: 1 };

    // loadJob reads
    if (sql.startsWith('SELECT cut_job_id, name, status, source, version, pdf_prewarm_state, failure_code, failure_reason, param_profile_id, sheet_material_type_id, pdf_template_code, combine_films, split_by_material FROM cut_job WHERE cut_job_id = $1')) {
      return { rows: [{ cut_job_id: 42, name: 'J', status: 'ready', source: 'manual', version: 1, pdf_prewarm_state: 'pending', failure_code: null, failure_reason: null, param_profile_id: null, sheet_material_type_id: null, pdf_template_code: 'default', combine_films: false, split_by_material: true }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT i.cut_job_id')) {
      return { rows: [{ cut_job_id: 42, positions: 0, details: 0, area: 0 }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT g.cut_job_id')) {
      return { rows: [{ cut_job_id: 42, sheets: 0 }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT cut_job_item_id, order_detail_id, order_id, qty, cut_group_id FROM cut_job_item')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT cut_group_id, sheet_material_type_id, film_id, status, summary FROM cut_group')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT cut_group_sheet_id, cut_group_id, sheet_index, png_cache_key, placements FROM cut_group_sheet')) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.startsWith('SELECT od.detail_id')) {
      return { rows: options.eligibleRows ?? [], rowCount: (options.eligibleRows ?? []).length };
    }

    return { rows: [], rowCount: 0 };
  };

  const client = { query: (text: string, params: readonly unknown[] = []) => Promise.resolve(handle(text, params)) };

  const service = {
    query: (text: string, params: readonly unknown[] = []) => Promise.resolve(handle(text, params)),
    async transaction<T>(fn: (c: typeof client) => Promise<T>) {
      return fn(client);
    },
  } as unknown as DatabaseService;

  return { queries, service };
}

function fakeFreecut(response: FreecutOptimizeResponse): FreecutClient {
  return { optimize: vi.fn().mockResolvedValue(response) } as unknown as FreecutClient;
}

/** Freecut stub that echoes one solution per request, referencing that request's
 *  own stock + items (so multi-group fan-out maps each group's pieces back). */
function echoFreecut(): FreecutClient {
  return {
    optimize: vi.fn().mockImplementation((req: { stock: Array<{ id: string; width_mm: number; height_mm: number }>; items: Array<{ id: string; width_mm: number; height_mm: number; qty?: number }> }) =>
      Promise.resolve({
        status: 'ok',
        summary: { used_stock_count: 1, waste_percent: 5 },
        solutions: [
          {
            stock_id: req.stock[0].id,
            index: 0,
            width_mm: req.stock[0].width_mm,
            height_mm: req.stock[0].height_mm,
            trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
            placements: req.items.flatMap((it, itemIndex) =>
              Array.from({ length: it.qty ?? 1 }, (_, instanceIndex) => ({
                item_id: it.id,
                instance: instanceIndex + 1,
                x_mm: (itemIndex + instanceIndex) * 620,
                y_mm: 0,
                width_mm: it.width_mm,
                height_mm: it.height_mm,
                rotated: false,
              })),
            ),
          },
        ],
      }),
    ),
  } as unknown as FreecutClient;
}

const happyResponse: FreecutOptimizeResponse = {
  status: 'ok',
  summary: { used_stock_count: 1, waste_percent: 12 },
  solutions: [
    {
      stock_id: 'smt-9',
      index: 0,
      width_mm: 2800,
      height_mm: 2070,
      trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
      placements: [
        { item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
      ],
    },
  ],
};

describe('PgCutRepository', () => {
  it('creates a draft job, reserves explicit details, writes cut_job.created audit', async () => {
    const db = createDatabase({ detailRows: { 1: { order_id: 9, quantity: 2 } } });
    const repo = new PgCutRepository(db.service, fakeFreecut(happyResponse));

    await repo.createJob({
      currentUser: currentUser(),
      dto: { name: 'Тест job', detailIds: [1] },
      requestId: 'req-c',
    });

    const sql = db.queries.map((q) => normalize(q.text));
    expect(sql.some((s) => s.startsWith('INSERT INTO cut_job ('))).toBe(true);
    expect(sql.some((s) => s.startsWith('INSERT INTO cut_job_item ('))).toBe(true);
    const audit = db.queries.find((q) => /INSERT INTO audit_log/i.test(q.text));
    expect(audit?.params[0]).toBe('cut_job.created');
  });

  it('does NOT translate a DB error into a reservation conflict (placement is non-exclusive, migration 031)', async () => {
    // The exclusivity unique index is gone, so there is no 23505→409 reservation
    // mapping anymore: a raw DB error must propagate untranslated (no swallowing
    // into a misleading CUT_DETAIL_ALREADY_RESERVED).
    const db = createDatabase({
      detailRows: { 1: { order_id: 9, quantity: 1 } },
      cutJob: { cut_job_id: 42, name: 'J', status: 'draft', source: 'manual', version: 0, pdf_prewarm_state: 'pending', params: null },
      reserveConflict: true,
    });
    const repo = new PgCutRepository(db.service, fakeFreecut(happyResponse));

    await expect(
      repo.addItems({ currentUser: currentUser(), cutJobId: 42, version: 0, dto: { detailIds: [1] }, requestId: 'r' }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects reserving a wrong-status detail with 422 CUT_DETAIL_NOT_ELIGIBLE (server-side eligibility)', async () => {
    const db = createDatabase({ detailRows: { 1: { order_id: 9, quantity: 1, production_status_id: 99 } } });
    const repo = new PgCutRepository(db.service, fakeFreecut(happyResponse));
    await expect(
      repo.createJob({ currentUser: currentUser(), dto: { name: 'Тест', detailIds: [1] }, requestId: 'r' }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'CUT_DETAIL_NOT_ELIGIBLE' });
  });

  it('rejects reserving a detail with no sheet spec (no_sheet_spec)', async () => {
    const db = createDatabase({ detailRows: { 1: { order_id: 9, quantity: 1, sheet_material_type_id: null } } });
    const repo = new PgCutRepository(db.service, fakeFreecut(happyResponse));
    await expect(
      repo.addItems({ currentUser: currentUser(), cutJobId: 42, version: 0, dto: { detailIds: [1] }, requestId: 'r' }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'CUT_DETAIL_NOT_ELIGIBLE' });
  });

  it('rejects a stale version on addItems with 409', async () => {
    const db = createDatabase({
      detailRows: { 1: { order_id: 9, quantity: 1 } },
      cutJob: { cut_job_id: 42, name: 'J', status: 'draft', source: 'manual', version: 5, pdf_prewarm_state: 'pending', params: null },
    });
    const repo = new PgCutRepository(db.service, fakeFreecut(happyResponse));

    await expect(
      repo.addItems({ currentUser: currentUser(), cutJobId: 42, version: 0, dto: { detailIds: [1] }, requestId: 'r' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CUT_STALE_VERSION' });
  });

  it('removeItem rejects a non-mutable (archived) job with 409', async () => {
    const db = createDatabase({
      cutJob: { cut_job_id: 42, name: 'J', status: 'archived', source: 'manual', version: 0, pdf_prewarm_state: 'pending', params: null },
    });
    const repo = new PgCutRepository(db.service, fakeFreecut(happyResponse));
    await expect(
      repo.removeItem({ currentUser: currentUser(), cutJobId: 42, cutJobItemId: 5, version: 0, requestId: 'r' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CUT_JOB_NOT_MUTABLE' });
  });

  it('calculate: single group happy path stores cut_group + sheets, ready, audit + outbox', async () => {
    const db = createDatabase({
      cutJob: { cut_job_id: 42, name: 'J', status: 'draft', source: 'manual', version: 0, pdf_prewarm_state: 'pending', params: null },
      calcItems: [
        {
          cut_job_item_id: 501,
          order_detail_id: 1,
          order_id: 9,
          qty: 1,
          width_mm: 600,
          height_mm: 400,
          sheet_material_type_id: 9,
          film_id: null,
          film_texture: null,
          smt_width_mm: 2800,
          smt_height_mm: 2070,
        },
      ],
    });
    const client = fakeFreecut(happyResponse);
    const repo = new PgCutRepository(db.service, client);

    await repo.calculate({ currentUser: currentUser(), cutJobId: 42, version: 0, requestId: 'r' });

    expect(client.optimize).toHaveBeenCalledTimes(1);
    const sql = db.queries.map((q) => normalize(q.text));
    expect(sql.some((s) => s.startsWith('INSERT INTO cut_group ('))).toBe(true);
    expect(sql.some((s) => s.startsWith('INSERT INTO cut_group_sheet ('))).toBe(true);
    const outbox = db.queries.find((q) => /INSERT INTO outbox_events/i.test(q.text));
    expect(outbox).toBeDefined();
    expect(String(outbox?.params[4])).toMatch(/^cut_job\.calculated:/);
    const audit = db.queries.find((q) => /INSERT INTO audit_log\b/i.test(q.text) && JSON.stringify(q.params).includes('cut_job.calculated'));
    expect(audit).toBeDefined();
  });

  it('calculate switches a large group to engine=heuristic and records engine_used in summary', async () => {
    const db = createDatabase({
      cutJob: { cut_job_id: 42, name: 'J', status: 'draft', source: 'manual', version: 0, pdf_prewarm_state: 'pending', params: null },
      calcItems: [
        {
          cut_job_item_id: 501,
          order_detail_id: 1,
          order_id: 9,
          qty: 3,
          width_mm: 600,
          height_mm: 400,
          sheet_material_type_id: 9,
          film_id: null,
          film_texture: null,
          smt_width_mm: 2800,
          smt_height_mm: 2070,
        },
      ],
    });
    const optimize = vi.fn(echoFreecut().optimize);
    const repo = new PgCutRepository(db.service, { optimize } as unknown as FreecutClient, undefined, {
      heuristicAutoThresholdInstances: 3,
    });

    await repo.calculate({ currentUser: currentUser(), cutJobId: 42, version: 0, requestId: 'r-auto' });

    const capturedRequest = optimize.mock.calls[0]?.[0] as {
      params: { engine?: string; cut_quality?: string };
    };
    expect(capturedRequest.params.engine).toBe('heuristic');
    expect(capturedRequest.params.cut_quality).toBe('max');

    const groupInsert = db.queries.find((q) => normalize(q.text).startsWith('INSERT INTO cut_group ('));
    const insertedSummary = JSON.parse(String(groupInsert?.params[3]));
    expect(insertedSummary.engine_used).toBe('heuristic');
    expect(insertedSummary.engine_reason).toBe('auto_threshold');

    const audit = db.queries.find((q) => /INSERT INTO audit_log\b/i.test(q.text) && JSON.stringify(q.params).includes('cut_job.calculated'));
    const metadata = JSON.parse(String(audit?.params[22]));
    expect(metadata.engines).toEqual([{ engine: 'heuristic', reason: 'auto_threshold', instances: 3 }]);
  });

  it('calculate below threshold keeps GA request without engine field', async () => {
    const db = createDatabase({
      cutJob: { cut_job_id: 42, name: 'J', status: 'draft', source: 'manual', version: 0, pdf_prewarm_state: 'pending', params: null },
      calcItems: [
        {
          cut_job_item_id: 501,
          order_detail_id: 1,
          order_id: 9,
          qty: 2,
          width_mm: 600,
          height_mm: 400,
          sheet_material_type_id: 9,
          film_id: null,
          film_texture: null,
          smt_width_mm: 2800,
          smt_height_mm: 2070,
        },
      ],
    });
    const optimize = vi.fn(echoFreecut().optimize);
    const repo = new PgCutRepository(db.service, { optimize } as unknown as FreecutClient, undefined, {
      heuristicAutoThresholdInstances: 3,
    });

    await repo.calculate({ currentUser: currentUser(), cutJobId: 42, version: 0, requestId: 'r-below-threshold' });

    const capturedRequest = optimize.mock.calls[0]?.[0] as {
      params: { engine?: string };
    };
    expect(capturedRequest.params.engine).toBeUndefined();
  });

  it('auto engine selection does NOT change request_hash or last_calc_params', async () => {
    const calcItems = [
      {
        cut_job_item_id: 501,
        order_detail_id: 1,
        order_id: 9,
        qty: 3,
        width_mm: 600,
        height_mm: 400,
        sheet_material_type_id: 9,
        film_id: null,
        film_texture: null,
        smt_width_mm: 2800,
        smt_height_mm: 2070,
      },
    ];

    const runCalculate = async (heuristicAutoThresholdInstances: number) => {
      const db = createDatabase({
        cutJob: { cut_job_id: 42, name: 'J', status: 'draft', source: 'manual', version: 0, pdf_prewarm_state: 'pending', params: null },
        calcItems,
      });
      const repo = new PgCutRepository(db.service, echoFreecut(), undefined, {
        heuristicAutoThresholdInstances,
      });

      await repo.calculate({ currentUser: currentUser(), cutJobId: 42, version: 0, requestId: `r-hash-${heuristicAutoThresholdInstances}` });

      const readyUpdate = db.queries.find((q) => /last_calc_params = \$3::jsonb/i.test(normalize(q.text)));
      return {
        requestHash: String(readyUpdate?.params[1]),
        lastCalcParams: JSON.parse(String(readyUpdate?.params[2])),
      };
    };

    const autoOff = await runCalculate(0);
    const autoOn = await runCalculate(3);

    expect(autoOn.requestHash).toBe(autoOff.requestHash);
    expect(autoOn.lastCalcParams).not.toHaveProperty('engine');
    expect(autoOn.lastCalcParams).not.toHaveProperty('cut_quality');
  });

  it('explicit profile engine DOES change request_hash', async () => {
    const baseConfig = new StaticCutConfig();
    const baseParams = await baseConfig.getDefaultParams();
    const calcItems = [
      {
        cut_job_item_id: 501,
        order_detail_id: 1,
        order_id: 9,
        qty: 1,
        width_mm: 600,
        height_mm: 400,
        sheet_material_type_id: 9,
        film_id: null,
        film_texture: null,
        smt_width_mm: 2800,
        smt_height_mm: 2070,
      },
    ];

    const runCalculate = async (paramsByProfile: typeof baseParams) => {
      const db = createDatabase({
        cutJob: {
          cut_job_id: 42,
          name: 'J',
          status: 'draft',
          source: 'manual',
          version: 0,
          pdf_prewarm_state: 'pending',
          params: null,
          param_profile_id: 5,
        },
        calcItems,
      });
      const repo = new PgCutRepository(
        db.service,
        echoFreecut(),
        stubConfig({ getParamsByProfileId: async () => paramsByProfile }),
      );

      await repo.calculate({ currentUser: currentUser(), cutJobId: 42, version: 0, requestId: 'r-profile-engine' });

      const readyUpdate = db.queries.find((q) => /last_calc_params = \$3::jsonb/i.test(normalize(q.text)));
      return String(readyUpdate?.params[1]);
    };

    const hashWithoutProfileEngine = await runCalculate(baseParams);
    const hashWithProfileEngine = await runCalculate({ ...baseParams, engine: 'heuristic', cut_quality: 'max' });

    expect(hashWithProfileEngine).not.toBe(hashWithoutProfileEngine);
  });

  it('calculate: rejects an optimizer layout below kerf before persisting any group', async () => {
    const db = createDatabase({
      cutJob: { cut_job_id: 42, name: 'J', status: 'draft', source: 'manual', version: 0, pdf_prewarm_state: 'pending', params: null },
      calcItems: [{
        cut_job_item_id: 501, order_detail_id: 1, order_id: 9, qty: 2,
        width_mm: 100, height_mm: 50, sheet_material_type_id: 9, film_id: null,
        film_texture: null, smt_width_mm: 1000, smt_height_mm: 500,
      }],
    });
    const params = {
      kerf_mm: 6.5, spacing_mm: 0,
      trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
      objective: 'min_waste' as const,
    };
    const client = {
      optimize: vi.fn().mockResolvedValue({
        status: 'ok',
        solutions: [{
          stock_id: 'smt-9', index: 0, width_mm: 1000, height_mm: 500,
          trim_mm: params.trim_mm,
          placements: [
            { item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 0, width_mm: 100, height_mm: 50, rotated: false },
            { item_id: 'det-1', instance: 2, x_mm: 105.5, y_mm: 0, width_mm: 100, height_mm: 50, rotated: false },
          ],
        }],
        unplaced_items: [],
      }),
    } as unknown as FreecutClient;
    const config = new StaticCutConfig();
    vi.spyOn(config, 'getDefaultParams').mockResolvedValue(params);
    const repo = new PgCutRepository(db.service, client, config);

    await expect(repo.calculate({ currentUser: currentUser(), cutJobId: 42, version: 0, requestId: 'r' }))
      .rejects.toMatchObject({ code: 'CUT_OPTIMIZER_INVALID_GEOMETRY' });

    const sql = db.queries.map((q) => normalize(q.text));
    expect(sql.some((s) => s.startsWith('INSERT INTO cut_group ('))).toBe(false);
    expect(sql.some((s) => s.startsWith('INSERT INTO cut_group_sheet ('))).toBe(false);
    const failedUpdate = db.queries.find((q) => /failure_code = \$3/i.test(q.text));
    expect(failedUpdate?.params).toContain('CUT_OPTIMIZER_INVALID_GEOMETRY');
  });

  it('calculate: multi-material fans out to N groups (one freecut call + cut_group per cuttable key)', async () => {
    const db = createDatabase({
      cutJob: { cut_job_id: 42, name: 'J', status: 'draft', source: 'manual', version: 0, pdf_prewarm_state: 'pending', params: null },
      calcItems: [
        { cut_job_item_id: 1, order_detail_id: 1, order_id: 9, qty: 1, width_mm: 600, height_mm: 400, material_id: 5, sheet_material_type_id: 9, film_id: null, film_texture: null, smt_width_mm: 2800, smt_height_mm: 2070 },
        { cut_job_item_id: 2, order_detail_id: 2, order_id: 10, qty: 1, width_mm: 600, height_mm: 400, material_id: 6, sheet_material_type_id: 11, film_id: null, film_texture: null, smt_width_mm: 2070, smt_height_mm: 2800 },
      ],
    });
    const client = echoFreecut();
    const repo = new PgCutRepository(db.service, client);

    await repo.calculate({ currentUser: currentUser(), cutJobId: 42, version: 0, requestId: 'r' });

    // One freecut optimize call per cuttable key.
    expect(client.optimize).toHaveBeenCalledTimes(2);
    const sql = db.queries.map((q) => normalize(q.text));
    expect(sql.filter((s) => s.startsWith('INSERT INTO cut_group (')).length).toBe(2);
    // Each group's items are assigned to that group (scoped by order_detail_id), not all-at-once.
    // (Exclude the recalc-clear `SET cut_group_id = NULL`.)
    const groupAssigns = db.queries.filter((q) => /UPDATE cut_job_item SET cut_group_id = \$1/i.test(q.text));
    expect(groupAssigns.length).toBe(2);
    expect(groupAssigns.every((q) => /order_detail_id = ANY/i.test(q.text))).toBe(true);
    // Exactly one outbox row for the whole job calc (idempotency over the full item set).
    const outbox = db.queries.filter((q) => /INSERT INTO outbox_events/i.test(q.text));
    expect(outbox.length).toBe(1);
    // The calculated audit carries both cut_group ids across all groups.
    const audit = db.queries.find((q) => /INSERT INTO audit_log\b/i.test(q.text) && JSON.stringify(q.params).includes('cut_job.calculated'));
    expect(audit).toBeDefined();
  });

  it('calculate: a single group freecut failure fails the whole job (no cut_group persisted)', async () => {
    const db = createDatabase({
      cutJob: { cut_job_id: 42, name: 'J', status: 'draft', source: 'manual', version: 0, pdf_prewarm_state: 'pending', params: null },
      calcItems: [
        { cut_job_item_id: 1, order_detail_id: 1, order_id: 9, qty: 1, width_mm: 600, height_mm: 400, material_id: 5, sheet_material_type_id: 9, film_id: null, film_texture: null, smt_width_mm: 2800, smt_height_mm: 2070 },
        { cut_job_item_id: 2, order_detail_id: 2, order_id: 10, qty: 1, width_mm: 600, height_mm: 400, material_id: 6, sheet_material_type_id: 11, film_id: null, film_texture: null, smt_width_mm: 2070, smt_height_mm: 2800 },
      ],
    });
    let call = 0;
    const partialFail = {
      optimize: vi.fn().mockImplementation(() => {
        call += 1;
        if (call === 2) {
          return Promise.reject(Object.assign(new Error('boom'), { status: 422, code: 'FREECUT_CONSTRAINT_ERROR' }));
        }
        return Promise.resolve(happyResponse);
      }),
    } as unknown as FreecutClient;
    const repo = new PgCutRepository(db.service, partialFail);

    await expect(
      repo.calculate({ currentUser: currentUser(), cutJobId: 42, version: 0, requestId: 'r' }),
      // Friendly rethrow preserves the freecut HTTP status (duck-typed `status`).
    ).rejects.toMatchObject({ code: 'FREECUT_CONSTRAINT_ERROR', statusCode: 422 });

    const sql = db.queries.map((q) => normalize(q.text));
    expect(sql.some((s) => s.startsWith('INSERT INTO cut_group ('))).toBe(false);
    const statusUpdate = db.queries.find((q) => /UPDATE cut_job SET status = 'failed'/i.test(normalize(q.text)));
    expect(statusUpdate).toBeDefined();
    // The failure persists a stable code + human-readable Russian reason.
    expect(statusUpdate?.params?.[2]).toBe('FREECUT_CONSTRAINT_ERROR');
    expect(String(statusUpdate?.params?.[3])).toMatch(/не помещаются на лист/i);
    const failAudit = db.queries.find((q) => /INSERT INTO audit_log/i.test(q.text) && JSON.stringify(q.params).includes('cut_job.calculate_failed'));
    expect(failAudit).toBeDefined();
  });

  it('calculate: freecut failure persists status failed + cut_job.calculate_failed audit, then rethrows', async () => {
    const db = createDatabase({
      cutJob: { cut_job_id: 42, name: 'J', status: 'draft', source: 'manual', version: 0, pdf_prewarm_state: 'pending', params: null },
      calcItems: [
        { cut_job_item_id: 1, order_detail_id: 1, order_id: 9, qty: 1, width_mm: 600, height_mm: 400, sheet_material_type_id: 9, film_id: null, film_texture: null, smt_width_mm: 2800, smt_height_mm: 2070 },
      ],
    });
    const failing = {
      optimize: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 504, code: 'FREECUT_TIMEOUT' })),
    } as unknown as FreecutClient;
    const repo = new PgCutRepository(db.service, failing);

    await expect(
      repo.calculate({ currentUser: currentUser(), cutJobId: 42, version: 0, requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'FREECUT_TIMEOUT', statusCode: 504 });

    const audit = db.queries.find((q) => /INSERT INTO audit_log/i.test(q.text) && JSON.stringify(q.params).includes('cut_job.calculate_failed'));
    expect(audit).toBeDefined();
    const statusUpdate = db.queries.find((q) => /UPDATE cut_job SET status = 'failed'/i.test(normalize(q.text)));
    expect(statusUpdate).toBeDefined();
    expect(statusUpdate?.params?.[2]).toBe('FREECUT_TIMEOUT');
    expect(String(statusUpdate?.params?.[3])).toMatch(/не успел/i);
  });

  it('calculate: a Phase 1 validation failure (no items) also marks failed + persists a reason', async () => {
    // A failed job retried with an emptied basket: the prep phase rejects with
    // CUT_NO_ITEMS BEFORE any freecut call — it must still refresh the durable
    // reason (never leave a stale one) and rethrow a friendly 422.
    const db = createDatabase({
      cutJob: { cut_job_id: 42, name: 'J', status: 'failed', source: 'manual', version: 3, pdf_prewarm_state: 'pending', params: null },
      calcItems: [],
    });
    const repo = new PgCutRepository(db.service, { optimize: vi.fn() } as unknown as FreecutClient);

    await expect(
      repo.calculate({ currentUser: currentUser(), cutJobId: 42, version: 3, requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'CUT_NO_ITEMS', statusCode: 422 });

    const statusUpdate = db.queries.find((q) => /UPDATE cut_job SET status = 'failed'/i.test(normalize(q.text)));
    expect(statusUpdate).toBeDefined();
    // Phase 1 guards on the version the calc STARTED with (command.version), not a
    // re-read — so a concurrent mutation that advanced the version is not clobbered.
    expect(statusUpdate?.params?.[1]).toBe(3);
    expect(statusUpdate?.params?.[2]).toBe('CUT_NO_ITEMS');
    expect(String(statusUpdate?.params?.[3])).toMatch(/нет деталей/i);
    const failAudit = db.queries.find((q) => /INSERT INTO audit_log/i.test(q.text) && JSON.stringify(q.params).includes('cut_job.calculate_failed'));
    expect(failAudit).toBeDefined();
  });

  it('calculate: a no-sheet-spec group persists CUT_NO_SHEET_SPEC (not a false "no items")', async () => {
    // Forced/legacy job with an active item whose material has no sheet spec: the
    // durable reason must name the real cause, not "В раскрое нет деталей".
    const db = createDatabase({
      cutJob: { cut_job_id: 42, name: 'J', status: 'ready', source: 'manual', version: 2, pdf_prewarm_state: 'pending', params: null },
      calcItems: [
        { cut_job_item_id: 1, order_detail_id: 1, order_id: 9, qty: 1, width_mm: 600, height_mm: 400, material_id: 5, sheet_material_type_id: 9, film_id: null, film_texture: null, smt_width_mm: null, smt_height_mm: null },
      ],
    });
    const repo = new PgCutRepository(db.service, { optimize: vi.fn() } as unknown as FreecutClient);

    await expect(
      repo.calculate({ currentUser: currentUser(), cutJobId: 42, version: 2, requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'CUT_NO_SHEET_SPEC', statusCode: 422 });

    const statusUpdate = db.queries.find((q) => /UPDATE cut_job SET status = 'failed'/i.test(normalize(q.text)));
    expect(statusUpdate?.params?.[2]).toBe('CUT_NO_SHEET_SPEC');
    expect(String(statusUpdate?.params?.[3])).toMatch(/раскройной спецификации/i);
    // The Phase 1 failure audit keeps query/report-ready related dimensions
    // (order/sheet) captured from the grouped items — not an empty set.
    // Variant B: material_id is NULL post-034; only order + sheet_material_type
    // dimensions are emitted (no 'material' entity in the related set).
    const relatedPairs = db.queries
      .filter((q) => /INSERT INTO audit_log_related_entity/i.test(q.text))
      .map((q) => `${q.params?.[1]}:${q.params?.[2]}`);
    expect(relatedPairs).toContain('order:9');
    expect(relatedPairs).toContain('sheet_material_type:9');
    expect(relatedPairs).not.toContain('material:5');
  });

  it('calculate: a stale-version precondition does NOT mark the job failed', async () => {
    // CUT_STALE_VERSION is a concurrency rejection, not a calculation outcome.
    const db = createDatabase({
      cutJob: { cut_job_id: 42, name: 'J', status: 'ready', source: 'manual', version: 5, pdf_prewarm_state: 'pending', params: null },
    });
    const repo = new PgCutRepository(db.service, { optimize: vi.fn() } as unknown as FreecutClient);

    await expect(
      repo.calculate({ currentUser: currentUser(), cutJobId: 42, version: 0, requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'CUT_STALE_VERSION', statusCode: 409 });

    const statusUpdate = db.queries.find((q) => /UPDATE cut_job SET status = 'failed'/i.test(normalize(q.text)));
    expect(statusUpdate).toBeUndefined();
  });

  it('listEligibleDetails classifies candidates and counts no_sheet_spec', async () => {
    const db = createDatabase({
      readyStatusIds: [1, 2, 3],
      eligibleRows: [
        { detail_id: 1, order_id: 9, quantity: 2, sheet_material_type_id: 9, film_id: null, production_status_id: 1, delete_flag: false },
        { detail_id: 2, order_id: 9, quantity: 1, sheet_material_type_id: null, film_id: null, production_status_id: 1, delete_flag: false },
      ],
    });
    const repo = new PgCutRepository(db.service, fakeFreecut(happyResponse));

    const result = await repo.listEligibleDetails({ currentUser: currentUser(), criteria: { orderIds: [9] }, requestId: 'r' });

    expect(result.details).toHaveLength(2);
    expect(result.details.find((d) => d.orderDetailId === 1)?.eligible).toBe(true);
    expect(result.details.find((d) => d.orderDetailId === 2)?.ineligibleReason).toBe('no_sheet_spec');
    expect(result.noSheetSpecCount).toBe(1);
  });

  it('listEligibleDetails carries the order name (users think in names, not ids)', async () => {
    const db = createDatabase({
      readyStatusIds: [1],
      eligibleRows: [
        { detail_id: 7, order_id: 9, order_name: 'Кухня Ивановых', quantity: 1, sheet_material_type_id: 9, film_id: null, production_status_id: 1, delete_flag: false },
      ],
    });
    const repo = new PgCutRepository(db.service, fakeFreecut(happyResponse));

    const result = await repo.listEligibleDetails({ currentUser: currentUser(), criteria: { orderIds: [9] }, requestId: 'r-name' });

    expect(result.details[0].orderName).toBe('Кухня Ивановых');
    const eligibleSql = db.queries
      .map((query) => query.text.replace(/\s+/g, ' ').trim())
      .find((sql) => sql.includes('FROM order_details od'));
    expect(eligibleSql).toContain('JOIN orders');
    expect(eligibleSql).toContain('order_name');
  });

  it('Variant B: treats a sheet detail with NULL material_id as eligible (no mandatory materials JOIN)', async () => {
    // Post-034: order_details.material_id IS NULL; sheet_material_type_id is authoritative.
    // The inner JOIN materials m ON m.material_id = od.material_id would drop every row.
    const db = createDatabase({
      readyStatusIds: [1],
      eligibleRows: [
        { detail_id: 5, order_id: 11, quantity: 1, sheet_material_type_id: 2, film_id: null, production_status_id: 1, delete_flag: false },
      ],
    });
    const repo = new PgCutRepository(db.service, fakeFreecut(happyResponse));

    const result = await repo.listEligibleDetails({ currentUser: currentUser(), criteria: { orderIds: [11] }, requestId: 'r-vb' });

    expect(result.details.map((d) => d.orderDetailId)).toContain(5);
    expect(result.details.find((d) => d.orderDetailId === 5)?.eligible).toBe(true);
  });

  it('Variant B: filters eligible details by sheetMaterialTypeIds (replaces materialIds filter)', async () => {
    const db = createDatabase({
      readyStatusIds: [1],
      eligibleRows: [
        { detail_id: 5, order_id: 11, quantity: 1, sheet_material_type_id: 2, film_id: null, production_status_id: 1, delete_flag: false },
      ],
    });
    const repo = new PgCutRepository(db.service, fakeFreecut(happyResponse));

    const result = await repo.listEligibleDetails({
      currentUser: currentUser(),
      criteria: { sheetMaterialTypeIds: [2] },
      requestId: 'r-vb-filter',
    });

    // The query must have used od.sheet_material_type_id = ANY(...) — verified by
    // the fake DB routing: the condition is built against sheetMaterialTypeIds.
    const sheetFilterQuery = db.queries.find((q) =>
      normalize(q.text).includes('od.sheet_material_type_id = ANY'),
    );
    expect(sheetFilterQuery).toBeDefined();
    expect(result.details.every((d) => d.sheetMaterialTypeId === 2)).toBe(true);
  });
});

describe('profileChangedOutboxKey', () => {
  it('is stable per (job, requestId), falls back to version', () => {
    expect(profileChangedOutboxKey(7, 'req-9', 3)).toBe('cut_job.profile_changed:7:req-9');
    expect(profileChangedOutboxKey(7, undefined, 3)).toBe('cut_job.profile_changed:7:v3');
  });
});

it('setProfile no-op (same profile) writes NO update/audit/outbox', async () => {
  // cutJob FOR UPDATE row already has param_profile_id = 5; target is also 5
  const db = createDatabase({ cutJob: { cut_job_id: 42, status: 'ready', version: 2, param_profile_id: 5 } });
  const repo = new PgCutRepository(db.service, /* freecut stub */ { optimize: vi.fn() } as never);
  await repo.setProfile({ currentUser: currentUser(), cutJobId: 42, paramProfileId: 5, version: 2 });
  const texts = db.queries.map((q) => normalize(q.text));
  expect(texts.some((t) => t.startsWith('UPDATE cut_job SET param_profile_id'))).toBe(false);
  expect(texts.some((t) => t.startsWith('INSERT INTO outbox_events'))).toBe(false);
  expect(texts.some((t) => t.includes('INTO audit_log'))).toBe(false);
});

it('setProfile rejects a calculating job with 409 (status gate)', async () => {
  const db = createDatabase({ cutJob: { cut_job_id: 42, status: 'calculating', version: 2, param_profile_id: null } });
  const repo = new PgCutRepository(db.service, { optimize: vi.fn() } as never);
  await expect(repo.setProfile({ currentUser: currentUser(), cutJobId: 42, paramProfileId: 5, version: 2 }))
    .rejects.toMatchObject({ statusCode: 409 });
});

it('calculate rejects an inactive chosen profile with 422 (no freecut call)', async () => {
  const optimize = vi.fn();
  // cutJob FOR UPDATE row carries param_profile_id = 5; config stub resolves it to null (inactive/removed)
  const db = createDatabase({
    cutJob: { cut_job_id: 42, status: 'draft', version: 0, pdf_prewarm_state: 'pending', params: null, param_profile_id: 5 },
    calcItems: [
      { cut_job_item_id: 501, order_detail_id: 1, order_id: 9, qty: 1, width_mm: 600, height_mm: 400, sheet_material_type_id: 9, film_id: null, film_texture: null, smt_width_mm: 2800, smt_height_mm: 2070 },
    ],
  });
  const repo = new PgCutRepository(db.service, { optimize } as never, stubConfig({ getParamsByProfileId: async () => null }));
  await expect(repo.calculate({ currentUser: currentUser(), cutJobId: 42, version: 0 }))
    .rejects.toMatchObject({ statusCode: 422 });
  expect(optimize).not.toHaveBeenCalled();
});

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type { FreecutClient } from './freecut-client';
import type { FreecutOptimizeResponse } from '../application/cut-freecut-mapping';
import type { CutConfigPort } from '../application/cut-config';
import { StaticCutConfig } from '../application/cut-config';
import {
  PgCutRepository,
  nameChangedOutboxKey,
  planCutResultAllocation,
  profileChangedOutboxKey,
  resolvePdfTemplateSelection,
  routingContractForCalcBasis,
  VACUUM_ROUTING_CONTRACT_VERSION,
} from './pg-cut-repository';

const repositorySource = readFileSync(new URL('./pg-cut-repository.ts', import.meta.url), 'utf8');

describe('vacuum bath meter-guide render wiring', () => {
  it('resolves catalog identity + frozen calculation mode and applies guides to current and historical renders', () => {
    expect(repositorySource).toContain('shouldShowBathMeterGuides({');
    expect(repositorySource).toContain('smt.name AS sheet_material_name');
    expect(repositorySource).toContain('smt.height_mm AS sheet_material_height_mm');
    expect(repositorySource).toContain('showBathMeterGuides,');
    expect(repositorySource).toContain('addBathMeterGuidesToSvg(baseSvg, placements');
    expect(repositorySource).toContain('addBathMeterGuidesToSvg(view.bathSvg, placements');
  });
});

describe('cut result number allocation', () => {
  const currentManual = {
    cutResultId: 902,
    resultNo: 2,
    revisionNo: 3,
    resultKind: 'manual' as const,
    basedOnResultId: 900,
  };

  it('reuses the current manual number and consumes only an internal revision', () => {
    expect(planCutResultAllocation({
      nextResultNo: 3,
      reuseCurrentManualVersion: true,
      current: currentManual,
    })).toEqual({
      resultNo: 2,
      revisionNo: 4,
      basedOnResultId: 900,
      nextResultNo: 3,
      reusesCurrentManualVersion: true,
    });
  });

  it('allocates a new public number for the first manual save after auto', () => {
    expect(planCutResultAllocation({
      nextResultNo: 2,
      reuseCurrentManualVersion: true,
      current: {
        cutResultId: 900,
        resultNo: 1,
        revisionNo: 1,
        resultKind: 'auto',
        basedOnResultId: null,
      },
    })).toEqual({
      resultNo: 2,
      revisionNo: 1,
      basedOnResultId: 900,
      nextResultNo: 3,
      reusesCurrentManualVersion: false,
    });
  });

  it('allocates the next public number when recalculation follows manual edits', () => {
    expect(planCutResultAllocation({
      nextResultNo: 3,
      reuseCurrentManualVersion: false,
      current: currentManual,
    })).toEqual({
      resultNo: 3,
      revisionNo: 1,
      basedOnResultId: 902,
      nextResultNo: 4,
      reusesCurrentManualVersion: false,
    });
  });
});

describe('calculation basis routing contract', () => {
  const base = {
    kerf_mm: 2,
    spacing_mm: 1,
    trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
    objective: 'min_waste' as const,
  };

  it('salts vacuum layouts with v2 while leaving non-vacuum layouts unsalted', () => {
    expect(routingContractForCalcBasis({ ...base, layout_mode: 'vacuum_table' }))
      .toBe(VACUUM_ROUTING_CONTRACT_VERSION);
    expect(routingContractForCalcBasis({ ...base, layout_mode: 'guillotine' }))
      .toBeNull();
    expect(routingContractForCalcBasis(base)).toBeNull();
  });
});

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

describe('resolvePdfTemplateSelection', () => {
  it('uses an active request override for any frozen result', () => {
    expect(resolvePdfTemplateSelection('bath_profiles', 'standard')).toEqual({
      code: 'bath_profiles',
      requiresActiveCheck: true,
    });
  });

  it('keeps the frozen template without requiring it to remain active', () => {
    expect(resolvePdfTemplateSelection(undefined, 'legacy_template')).toEqual({
      code: 'legacy_template',
      requiresActiveCheck: false,
    });
    expect(resolvePdfTemplateSelection('legacy_template', 'legacy_template')).toEqual({
      code: 'legacy_template',
      requiresActiveCheck: false,
    });
  });

  it('defaults a non-frozen request to active standard', () => {
    expect(resolvePdfTemplateSelection(undefined, undefined)).toEqual({
      code: 'standard',
      requiresActiveCheck: true,
    });
  });
});

describe('cut PDF CNC enrichment contract', () => {
  it('loads deterministic latest-day matched CNC machine files by order detail', () => {
    expect(repositorySource).toContain('FROM cnc_telegram_packet_items cti');
    expect(repositorySource).toContain('cti.match_detail_id = od.detail_id');
    expect(repositorySource).toContain("cti.match_status = 'matched'");
    expect(repositorySource).toContain('max(p2.workday) AS latest_workday');
    expect(repositorySource).toContain("COALESCE(NULLIF(trim(p.program_name), ''), p.external_packet_key)");
  });
});

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
  /** rows for per-detail cut-job placement lookup */
  placementRows?: FakeRow[];
  /** rows for listFilmOptionsForCut */
  filmOptionRows?: FakeRow[];
  /** whether the cut_param_profiles SELECT returns a row (profile is active) */
  profileActive?: boolean;
  /** expired calculate commands returned to the reconciliation worker */
  expiredCommandRows?: FakeRow[];
}

function createDatabase(options: FakeDbOptions = {}) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  let cutGroupSeq = 100;
  let itemSeq = 500;
  let jobVersion = (options.cutJob?.version as number | undefined) ?? 0;
  let currentResultId: number | null = null;
  let nextResultNo = 1;
  let lastCalcParams: unknown = null;
  const groupByDetail = new Map<number, number>();
  const storedGroups: FakeRow[] = [];
  const storedSheets: FakeRow[] = [];
  let storedResult: FakeRow | null = null;
  let storedCalculateCommand: FakeRow | null = null;

  const handle = (text: string, params: readonly unknown[]) => {
    queries.push({ text, params });
    const sql = normalize(text);

    if (sql.startsWith('SELECT set_session_user')) return { rows: [], rowCount: 0 };

    if (sql.startsWith('SELECT c.cut_job_id, c.command_id, c.claimed_job_version')) {
      const rows = options.expiredCommandRows ?? [];
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith('SELECT command_type, payload_hash, status, cut_result_id, failure_code,')) {
      return storedCalculateCommand
        ? { rows: [storedCalculateCommand], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT 1 FROM cut_result_command')) return { rows: [{ '?column?': 1 }], rowCount: 1 };

    if (sql.startsWith('INSERT INTO cut_job (')) {
      return { rows: [{ cut_job_id: 42 }], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO cut_result_command') && sql.includes("'calculate'")) {
      storedCalculateCommand = {
        command_type: 'calculate',
        payload_hash: params[2],
        status: 'in_progress',
        cut_result_id: null,
        failure_code: null,
        lease_alive: true,
        claimed_job_version: params[5],
      };
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE cut_result_command SET status = 'completed'")) {
      if (storedCalculateCommand) {
        storedCalculateCommand = {
          ...storedCalculateCommand,
          status: 'completed',
          cut_result_id: params[2],
          lease_expires_at: null,
        };
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('SELECT cut_job_id, name, status, source, version, pdf_prewarm_state, params, param_profile_id, sheet_material_type_id, combine_films, split_by_material FROM cut_job WHERE cut_job_id = $1 FOR UPDATE')) {
      const base = options.cutJob ?? { cut_job_id: 42, name: 'J', status: 'draft', source: 'manual', version: 0, pdf_prewarm_state: 'pending', params: null };
      return { rows: [{ ...base, version: jobVersion, param_profile_id: options.cutJob?.param_profile_id ?? null, sheet_material_type_id: options.cutJob?.sheet_material_type_id ?? null, combine_films: options.cutJob?.combine_films ?? false, split_by_material: options.cutJob?.split_by_material ?? true }], rowCount: 1 };
    }

    if (sql.startsWith('SELECT cut_job_id FROM cut_job WHERE cut_job_id = $1 FOR UPDATE')) {
      return { rows: [{ cut_job_id: options.cutJob?.cut_job_id ?? 42 }], rowCount: 1 };
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
      if (sql.includes('last_calc_params = $3::jsonb')) lastCalcParams = JSON.parse(String(params[2]));
      if (sql.includes('current_cut_result_id = $2')) {
        currentResultId = Number(params[1]);
        nextResultNo = Number(params[2]);
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE cut_job_item SET cut_group_id = $1')) {
      for (const detailId of params[2] as number[]) groupByDetail.set(detailId, Number(params[0]));
      return { rows: [], rowCount: (params[2] as number[]).length };
    }

    if (sql.startsWith('SELECT cji.cut_job_item_id')) {
      return { rows: options.calcItems ?? [], rowCount: (options.calcItems ?? []).length };
    }

    if (sql.startsWith('SELECT cji.order_detail_id, cji.order_id,')) {
      const rows = (options.calcItems ?? []).map((item) => ({
        order_detail_id: item.order_detail_id,
        order_id: item.order_id,
        detail_fields: item.detail_fields ?? null,
        detail_number: item.detail_number ?? null,
        width: item.width_mm,
        height: item.height_mm,
        sheet_material_type_id: item.sheet_material_type_id,
        material_id: item.material_id ?? null,
        doweling: item.doweling ?? null,
        material_name: item.material_name ?? null,
        thickness_mm: item.thickness_mm ?? null,
        film_name: item.film_name ?? null,
        milling_type_name: item.milling_type_name ?? null,
        edge_type_name: item.edge_type_name ?? null,
        production_status_name: item.production_status_name ?? null,
        machine_files: item.machine_files ?? null,
        order_name: item.order_name ?? null,
        order_delete_flag: item.order_delete_flag ?? null,
        order_date: item.order_date ?? null,
        completion_date: item.completion_date ?? null,
        planned_completion_date: item.planned_completion_date ?? null,
        client_name: item.client_name ?? null,
      }));
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith('SELECT production_status_id FROM production_statuses')) {
      const ids = options.readyStatusIds ?? [1, 2, 3];
      return { rows: ids.map((id) => ({ production_status_id: id })), rowCount: ids.length };
    }

    if (sql.startsWith('INSERT INTO cut_group (')) {
      const cutGroupId = ++cutGroupSeq;
      storedGroups.push({
        cut_group_id: cutGroupId,
        sheet_material_type_id: params[1],
        film_id: params[2],
        status: 'ready',
        summary: JSON.parse(String(params[3])),
        group_key: params[4],
        pdf_template_code: 'standard',
      });
      return { rows: [{ cut_group_id: cutGroupId }], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO cut_group_sheet (')) {
      storedSheets.push({
        cut_group_sheet_id: storedSheets.length + 1,
        cut_group_id: params[0],
        sheet_index: params[1],
        png_cache_key: null,
        placements: JSON.parse(String(params[3])),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO cut_result ')) {
      storedResult = {
        cut_result_id: 900,
        cut_job_id: params[0],
        result_no: params[1],
        revision_no: params[2],
        result_kind: params[3],
        source_job_version: params[4],
        based_on_result_id: params[5],
        snapshot_job: JSON.parse(String(params[9])),
        snapshot_manifest: JSON.parse(String(params[10])),
        snapshot_digest: 'fake-digest',
        computed_digest: 'fake-digest',
        totals_snapshot: JSON.parse(String(params[11])),
        created_by: params[12],
        created_by_name_snapshot: params[13],
        created_at: new Date('2026-07-21T00:00:00Z'),
        is_current: false,
      };
      return { rows: [storedResult], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO outbox_events')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('INSERT INTO audit_log')) return { rows: [{ audit_id: 'aud-1' }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO audit_log_related_entity')) return { rows: [], rowCount: 1 };

    // loadJob reads
    if (sql.startsWith('SELECT cut_job_id, name, status, source, version, pdf_prewarm_state, failure_code, failure_reason, param_profile_id, sheet_material_type_id, pdf_template_code, combine_films, split_by_material FROM cut_job WHERE cut_job_id = $1')) {
      return { rows: [{ cut_job_id: 42, name: 'J', status: 'ready', source: 'manual', version: jobVersion, pdf_prewarm_state: 'pending', failure_code: null, failure_reason: null, param_profile_id: null, sheet_material_type_id: null, pdf_template_code: 'default', combine_films: false, split_by_material: true }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT i.cut_job_id')) {
      return { rows: [{ cut_job_id: 42, positions: 0, details: 0, area: 0 }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT g.cut_job_id')) {
      return { rows: [{ cut_job_id: 42, sheets: 0 }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT cut_job_item_id, order_detail_id, order_id, qty, cut_group_id FROM cut_job_item')) {
      const rows = (options.calcItems ?? []).map((item) => ({
        cut_job_item_id: item.cut_job_item_id,
        order_detail_id: item.order_detail_id,
        order_id: item.order_id,
        qty: item.qty,
        cut_group_id: groupByDetail.get(Number(item.order_detail_id)) ?? null,
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('SELECT i.cut_job_item_id, i.order_detail_id')) {
      const rows = (options.calcItems ?? []).map((item) => ({
        cut_job_item_id: item.cut_job_item_id,
        order_detail_id: item.order_detail_id,
        order_id: item.order_id,
        qty: item.qty,
        cut_group_id: groupByDetail.get(Number(item.order_detail_id)) ?? null,
        joined_detail_id: item.order_detail_id,
        detail_fields: null,
        detail_number: item.detail_number ?? null,
        detail_name: null,
        height: item.height_mm,
        width: item.width_mm,
        detail_quantity: item.qty,
        area: 0,
        material_id: null,
        sheet_material_type_id: item.sheet_material_type_id,
        material_name: null,
        milling_type_id: null,
        milling_type_name: null,
        edge_type_id: null,
        edge_type_name: null,
        film_id: item.film_id,
        film_name: null,
        priority: null,
        production_status_id: null,
        production_status_name: null,
        joint_order_id: null,
        note: null,
        order_name: null,
        order_delete_flag: item.order_delete_flag ?? null,
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('SELECT cut_group_id, sheet_material_type_id, film_id, status, pdf_template_code, summary FROM cut_group')) {
      return { rows: storedGroups, rowCount: storedGroups.length };
    }
    if (sql.startsWith('SELECT cg.cut_job_id, cg.group_key, cg.summary, cj.last_calc_params,')) {
      const group = storedGroups.find((candidate) => Number(candidate.cut_group_id) === Number(params[0]));
      return group
        ? {
            rows: [{
              cut_job_id: 42,
              group_key: group.group_key,
              summary: group.summary ?? null,
              last_calc_params: lastCalcParams,
              sheet_material_name: null,
              sheet_material_height_mm: null,
            }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT cgs.sheet_index, cgs.placements FROM cut_group_sheet')) {
      const rows = storedSheets
        .filter((sheet) => Number(sheet.cut_group_id) === Number(params[0]))
        .map((sheet) => ({ sheet_index: sheet.sheet_index, placements: sheet.placements }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('SELECT cut_group_sheet_id, cut_group_id, sheet_index, png_cache_key, placements FROM cut_group_sheet')) {
      return { rows: storedSheets, rowCount: storedSheets.length };
    }
    if (sql.startsWith('SELECT last_calc_params FROM cut_job')) return { rows: [{ last_calc_params: lastCalcParams }], rowCount: 1 };
    if (sql.startsWith('SELECT cut_group_id, group_key FROM cut_group')) return { rows: storedGroups, rowCount: storedGroups.length };
    if (sql.startsWith('SELECT group_key, sheets, is_active, is_stale, version FROM cut_group_manual_layout')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT j.version, j.next_cut_result_no, j.current_cut_result_id, j.request_hash,')) {
      return {
        rows: [{
          version: jobVersion,
          next_cut_result_no: nextResultNo,
          current_cut_result_id: currentResultId,
          request_hash: null,
          current_result_no: storedResult?.result_no ?? null,
          current_revision_no: storedResult?.revision_no ?? null,
          current_result_kind: storedResult?.result_kind ?? null,
          current_based_on_result_id: storedResult?.based_on_result_id ?? null,
          current_created_by: storedResult?.created_by ?? null,
          current_created_by_name_snapshot: storedResult?.created_by_name_snapshot ?? null,
          current_created_at: storedResult?.created_at ?? null,
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith('SELECT snapshot_job, snapshot_manifest, snapshot_digest')) {
      return storedResult ? { rows: [{ ...storedResult, computed_digest: storedResult.snapshot_digest }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT DISTINCT ON (r.result_no)') || sql.startsWith('SELECT r.cut_result_id')) {
      return storedResult ? { rows: [{ ...storedResult, computed_digest: storedResult.snapshot_digest, is_current: currentResultId === 900 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (sql.startsWith('SELECT DISTINCT od.film_id')) {
      return { rows: options.filmOptionRows ?? [], rowCount: (options.filmOptionRows ?? []).length };
    }

    if (sql.startsWith('SELECT cji.order_detail_id, cj.cut_job_id')) {
      return { rows: options.placementRows ?? [], rowCount: (options.placementRows ?? []).length };
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

  it('calculate stores one result and same-command retry returns it without duplicate side effects', async () => {
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

    const command = { currentUser: currentUser(), cutJobId: 42, version: 0, commandId: '11111111-1111-4111-8111-111111111111', requestId: 'r' };
    await repo.calculate(command);
    await repo.calculate(command);

    expect(client.optimize).toHaveBeenCalledTimes(1);
    const sql = db.queries.map((q) => normalize(q.text));
    expect(sql.some((s) => s.startsWith('INSERT INTO cut_group ('))).toBe(true);
    expect(sql.some((s) => s.startsWith('INSERT INTO cut_group_sheet ('))).toBe(true);
    expect(sql.some((s) => s.startsWith('INSERT INTO cut_result ('))).toBe(true);
    expect(sql.filter((s) => s.startsWith('INSERT INTO cut_result ('))).toHaveLength(1);
    expect(sql.some((s) => s.includes('current_cut_result_id = $2'))).toBe(true);
    const outbox = db.queries.find((q) => /INSERT INTO outbox_events/i.test(q.text));
    expect(outbox).toBeDefined();
    expect(String(outbox?.params[4])).toMatch(/^cut_job\.calculated:/);
    const audit = db.queries.find((q) => /INSERT INTO audit_log\b/i.test(q.text) && JSON.stringify(q.params).includes('cut_job.calculated'));
    expect(audit).toBeDefined();
    expect(
      db.queries.some((q) => /INSERT INTO audit_log_related_entity/i.test(q.text) && q.params[1] === 'cut_result' && q.params[2] === 900),
    ).toBe(true);
    expect(db.queries.filter((q) => /INSERT INTO outbox_events/i.test(q.text))).toHaveLength(1);
  });

  it('calculate snapshots optimizer unplaced instances without losing a successful result', async () => {
    const db = createDatabase({
      cutJob: { cut_job_id: 42, name: 'J', status: 'draft', source: 'manual', version: 0, pdf_prewarm_state: 'pending', params: null },
      calcItems: [{
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
      }],
    });
    const response: FreecutOptimizeResponse = {
      ...happyResponse,
      unplaced_items: [{ item_id: 'det-1', instance: 2, reason: 'no_space' }],
    };
    const repo = new PgCutRepository(db.service, fakeFreecut(response));

    await repo.calculate({
      currentUser: currentUser(),
      cutJobId: 42,
      version: 0,
      commandId: '22222222-2222-4222-8222-222222222222',
      requestId: 'r-unplaced',
    });

    const resultInsert = db.queries.find((query) => normalize(query.text).startsWith('INSERT INTO cut_result ('));
    const snapshot = JSON.parse(String(resultInsert?.params[9])) as {
      unplaced: Array<{ itemId: string; instance: number; reason?: string }>;
      groups: Array<{ sheets: Array<{ renderSnapshot?: { contractVersion: string; views: Record<string, unknown> } }> }>;
    };
    expect(snapshot.unplaced).toEqual([{ itemId: 'det-1', instance: 2, reason: 'no_space' }]);
    expect(snapshot.groups[0]?.sheets[0]?.renderSnapshot?.contractVersion).toBe('cut_sheet_render_v1');
    expect(Object.keys(snapshot.groups[0]?.sheets[0]?.renderSnapshot?.views ?? {})).toHaveLength(12);
  });

  it('calculate freezes PDF detail rows with doweling and merged machine files', async () => {
    const db = createDatabase({
      cutJob: { cut_job_id: 42, name: 'J', status: 'draft', source: 'manual', version: 0, pdf_prewarm_state: 'pending', params: null },
      calcItems: [{
        cut_job_item_id: 501,
        order_detail_id: 1,
        order_id: 9,
        qty: 2,
        width_mm: 600,
        height_mm: 400,
        detail_number: 12,
        sheet_material_type_id: 9,
        film_id: null,
        film_texture: null,
        smt_width_mm: 2800,
        smt_height_mm: 2070,
        doweling: true,
        edge_type_name: 'ПВХ 2мм',
        machine_files: ['CNC#1_11380.TXT', 'CNC#2_11380.TXT'],
        order_name: '11380',
      }],
    });
    const repo = new PgCutRepository(db.service, echoFreecut());

    await repo.calculate({
      currentUser: currentUser(),
      cutJobId: 42,
      version: 0,
      commandId: '55555555-5555-4555-8555-555555555555',
      requestId: 'r-machine-files',
    });

    const resultInsert = db.queries.find((query) => normalize(query.text).startsWith('INSERT INTO cut_result ('));
    const snapshot = JSON.parse(String(resultInsert?.params[9])) as {
      groups: Array<{
        sheets: Array<{
          renderSnapshot?: {
            pdfMeta?: { machineFiles?: string[]; edgeTypes?: string[] };
            pdfDetailRows?: Array<{
              quantity: number;
              machineFiles?: string[];
              fields?: Record<string, unknown>;
            }>;
          };
        }>;
      }>;
    };
    const renderSnapshot = snapshot.groups[0]?.sheets[0]?.renderSnapshot;
    const row = renderSnapshot?.pdfDetailRows?.[0];

    expect(renderSnapshot?.pdfMeta?.machineFiles).toEqual(['CNC#1_11380.TXT', 'CNC#2_11380.TXT']);
    expect(renderSnapshot?.pdfMeta?.edgeTypes).toEqual(['ПВХ 2мм']);
    expect(row?.quantity).toBe(2);
    expect(row?.machineFiles).toEqual(['CNC#1_11380.TXT', 'CNC#2_11380.TXT']);
    expect(row?.fields).toMatchObject({
      doweling: true,
      sheet_quantity: 2,
      machine_file: 'CNC#1_11380.TXT, CNC#2_11380.TXT',
      machine_files: 'CNC#1_11380.TXT, CNC#2_11380.TXT',
    });
  });

  it('reconciles expired calculate commands and only fails the job at the claimed version', async () => {
    const db = createDatabase({
      expiredCommandRows: [{
        cut_job_id: 42,
        command_id: '33333333-3333-4333-8333-333333333333',
        claimed_job_version: 7,
      }],
    });
    const repo = new PgCutRepository(db.service, fakeFreecut(happyResponse));

    await expect(repo.reconcileExpiredCommands(999)).resolves.toBe(1);

    const claim = db.queries.find((query) => /FROM cut_result_command c/i.test(query.text));
    expect(claim?.params).toEqual([500]);
    expect(normalize(claim?.text ?? '')).toContain('FOR UPDATE OF c, j SKIP LOCKED');
    const jobUpdate = db.queries.find((query) => /failure_reason = 'Предыдущий процесс расчёта был прерван'/i.test(query.text));
    expect(jobUpdate?.params).toEqual([42, 7]);
    expect(normalize(jobUpdate?.text ?? '')).toContain("status = 'calculating' AND version = $2");
  });

  it('rejects a different commandId while the job is already calculating', async () => {
    const db = createDatabase({
      cutJob: { cut_job_id: 42, name: 'J', status: 'calculating', source: 'manual', version: 1, pdf_prewarm_state: 'pending', params: null },
      calcItems: [{
        cut_job_item_id: 501, order_detail_id: 1, order_id: 9, qty: 1,
        width_mm: 600, height_mm: 400, sheet_material_type_id: 9,
        film_id: null, film_texture: null, smt_width_mm: 2800, smt_height_mm: 2070,
      }],
    });
    const client = fakeFreecut(happyResponse);
    const repo = new PgCutRepository(db.service, client);

    await expect(repo.calculate({
      currentUser: currentUser(),
      cutJobId: 42,
      version: 1,
      commandId: '44444444-4444-4444-8444-444444444444',
      requestId: 'r-reload',
    })).rejects.toMatchObject({ code: 'CUT_CALCULATION_IN_PROGRESS' });

    expect(client.optimize).not.toHaveBeenCalled();
    expect(db.queries.some((query) => /INSERT INTO cut_result_command/i.test(query.text))).toBe(false);
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

  it('listEligibleDetails defaults to ready statuses unless preview asks for all statuses', async () => {
    const db = createDatabase({
      readyStatusIds: [1],
      eligibleRows: [
        { detail_id: 1, order_id: 9, quantity: 1, sheet_material_type_id: 9, film_id: null, production_status_id: 1, delete_flag: false },
        { detail_id: 2, order_id: 9, quantity: 1, sheet_material_type_id: 9, film_id: null, production_status_id: 99, delete_flag: false },
      ],
    });
    const repo = new PgCutRepository(db.service, fakeFreecut(happyResponse));

    await repo.listEligibleDetails({ currentUser: currentUser(), criteria: { orderIds: [9] }, requestId: 'r-ready-only' });
    const readyOnlyQuery = db.queries.find((q) => normalize(q.text).includes('FROM order_details od'));
    expect(normalize(readyOnlyQuery?.text ?? '')).toContain('od.production_status_id = ANY');

    db.queries.length = 0;
    const preview = await repo.listEligibleDetails({
      currentUser: currentUser(),
      criteria: { orderIds: [9] },
      includeAllStatuses: true,
      requestId: 'r-all-statuses',
    });

    const previewQuery = db.queries.find((q) => normalize(q.text).includes('FROM order_details od'));
    expect(normalize(previewQuery?.text ?? '')).not.toContain('od.production_status_id = ANY');
    expect(preview.details.find((d) => d.orderDetailId === 1)?.eligible).toBe(true);
    expect(preview.details.find((d) => d.orderDetailId === 2)?.ineligibleReason).toBe('wrong_status');
  });

  it('listEligibleDetails carries order/client and order-detail fields for preview', async () => {
    const db = createDatabase({
      readyStatusIds: [1],
      eligibleRows: [
        {
          detail_id: 7,
          order_id: 9,
          order_name: 'Кухня Ивановых',
          client_name: 'Иванов',
          detail_number: 12,
          detail_name: 'Фасад',
          width: 500,
          height: 300,
          quantity: 1,
          area: '0.15',
          material_name: 'МДФ 18',
          film_id: 5,
          film_name: 'Белый матовый',
          production_status_name: 'Готов к раскрою',
          sheet_material_type_id: 9,
          production_status_id: 1,
          delete_flag: false,
        },
      ],
    });
    const repo = new PgCutRepository(db.service, fakeFreecut(happyResponse));

    const result = await repo.listEligibleDetails({ currentUser: currentUser(), criteria: { orderIds: [9] }, requestId: 'r-name' });

    expect(result.details[0].orderName).toBe('Кухня Ивановых');
    expect(result.details[0]).toMatchObject({
      clientName: 'Иванов',
      detailNumber: 12,
      detailName: 'Фасад',
      width: 500,
      height: 300,
      area: 0.15,
      materialName: 'МДФ 18',
      filmId: 5,
      filmName: 'Белый матовый',
      productionStatusName: 'Готов к раскрою',
    });
    const eligibleSql = db.queries
      .map((query) => query.text.replace(/\s+/g, ' ').trim())
      .find((sql) => sql.includes('FROM order_details od'));
    expect(eligibleSql).toContain('JOIN orders');
    expect(eligibleSql).toContain('LEFT JOIN clients');
    expect(eligibleSql).toContain('LEFT JOIN films');
    expect(eligibleSql).toContain('order_name');
    expect(eligibleSql).toContain('ord.delete_flag = false');
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

  it('listEligibleDetails includes existing cut jobs with their profile for each detail', async () => {
    const db = createDatabase({
      readyStatusIds: [1],
      eligibleRows: [
        { detail_id: 5, order_id: 11, quantity: 1, sheet_material_type_id: 2, film_id: null, production_status_id: 1, delete_flag: false },
      ],
      placementRows: [
        {
          order_detail_id: 5,
          cut_job_id: 42,
          name: 'Раскрой 42',
          status: 'ready',
          is_active: true,
          param_profile_id: 7,
          profile_name: 'Вакуум Авто',
          profile_is_active: true,
        },
        {
          order_detail_id: 5,
          cut_job_id: 41,
          name: 'Старый раскрой',
          status: 'archived',
          is_active: true,
          param_profile_id: null,
          profile_name: null,
          profile_is_active: null,
        },
      ],
    });
    const repo = new PgCutRepository(db.service, fakeFreecut(happyResponse));

    const result = await repo.listEligibleDetails({ currentUser: currentUser(), criteria: { orderIds: [11] }, requestId: 'r-placement-profile' });
    const detail = result.details.find((d) => d.orderDetailId === 5);

    expect(detail?.activeJobs).toEqual([
      { cutJobId: 42, name: 'Раскрой 42', paramProfileId: 7, profileName: 'Вакуум Авто', profileIsActive: true },
    ]);
    expect(detail?.archivedJobs).toEqual([
      { cutJobId: 41, name: 'Старый раскрой', paramProfileId: null, profileName: null, profileIsActive: null },
    ]);
    expect(detail?.inArchivedJob).toBe(true);
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

  it('filters eligible details by inclusive order date range', async () => {
    const db = createDatabase({
      readyStatusIds: [1],
      eligibleRows: [
        { detail_id: 12, order_id: 11, order_name: '2561', quantity: 1, sheet_material_type_id: 2, film_id: null, production_status_id: 1, delete_flag: false },
      ],
    });
    const repo = new PgCutRepository(db.service, fakeFreecut(happyResponse));

    await repo.listEligibleDetails({
      currentUser: currentUser(),
      criteria: { dateFrom: '2026-07-16', dateTo: '2026-07-26' },
      requestId: 'r-date',
    });

    const eligibleQuery = db.queries.find((q) => normalize(q.text).includes('FROM order_details od'));
    expect(normalize(eligibleQuery?.text ?? '')).toContain('ord.order_date >= $');
    expect(normalize(eligibleQuery?.text ?? '')).toContain('ord.order_date <= $');
    expect(eligibleQuery?.params).toContain('2026-07-16');
    expect(eligibleQuery?.params).toContain('2026-07-26');
  });

  it('listFilmOptionsForCut returns distinct film options filtered by order date range', async () => {
    const db = createDatabase({
      filmOptionRows: [
        { film_id: '7', film_name: 'Белый матовый' },
        { film_id: '8', film_name: 'Дуб натуральный' },
      ],
    });
    const repo = new PgCutRepository(db.service, fakeFreecut(happyResponse));

    const result = await repo.listFilmOptionsForCut({
      currentUser: currentUser(),
      criteria: { dateFrom: '2026-07-01', dateTo: '2026-07-31', sheetMaterialTypeIds: [3] },
      requestId: 'r-films',
    });

    expect(result).toEqual([
      { filmId: 7, name: 'Белый матовый' },
      { filmId: 8, name: 'Дуб натуральный' },
    ]);
    const filmQuery = db.queries.find((q) => normalize(q.text).includes('SELECT DISTINCT od.film_id'));
    expect(normalize(filmQuery?.text ?? '')).toContain('JOIN orders');
    expect(normalize(filmQuery?.text ?? '')).toContain('JOIN films');
    expect(normalize(filmQuery?.text ?? '')).toContain('ord.order_date >= $');
    expect(normalize(filmQuery?.text ?? '')).toContain('ord.order_date <= $');
    expect(normalize(filmQuery?.text ?? '')).toContain('od.sheet_material_type_id = ANY');
    expect(normalize(filmQuery?.text ?? '')).not.toContain('od.production_status_id = ANY');
    expect(filmQuery?.params).toContain('2026-07-01');
    expect(filmQuery?.params).toContain('2026-07-31');
  });
});

describe('profileChangedOutboxKey', () => {
  it('is stable per (job, requestId), falls back to version', () => {
    expect(profileChangedOutboxKey(7, 'req-9', 3)).toBe('cut_job.profile_changed:7:req-9');
    expect(profileChangedOutboxKey(7, undefined, 3)).toBe('cut_job.profile_changed:7:v3');
  });
});

describe('nameChangedOutboxKey', () => {
  it('is stable per (job, requestId), falls back to version', () => {
    expect(nameChangedOutboxKey(7, 'req-9', 3)).toBe('cut_job.name_changed:7:req-9');
    expect(nameChangedOutboxKey(7, undefined, 3)).toBe('cut_job.name_changed:7:v3');
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

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { CncTelegramCutLayoutDto } from '../../cnc-telegram/dto/cnc-telegram.dto';
import { parseManualSvgUpload } from '../../cnc-telegram/http/cnc-telegram.controller';
import { PgCncTelegramRepository } from '../../cnc-telegram/adapters/pg-cnc-telegram-repository';
import {
  FROZEN_SHEET_STORED_VIEW_KEY,
  FROZEN_SHEET_VIEWS,
  frozenSheetViewKey,
  renderFrozenSheetView,
} from '../render/frozen-sheet-render';
import { RENDER_SNAPSHOT_CONTRACT_SETTING_KEY } from './frozen-render-contract';

// The SVG-import writer end to end on an owned clone with migration 231: the real manual upload
// (transaction, contract switch, CHECK, manifest, label-map projection), once with contract v2 and
// once switched back to v1, then every v2 view drawn from the stored model must equal the v1
// views of the same layout. Opt-in via CUT_RENDER_V2_DATABASE_URL; writes E2E rows, so it runs only
// against a disposable clone made by the cut render parity runner (dropped by the runner afterwards).
const url = process.env.CUT_RENDER_V2_DATABASE_URL;
const DISPOSABLE_CLONE = /^cut_golden_run_[0-9a-f]{12}$/;

function layoutOf(file: string): CncTelegramCutLayoutDto {
  return JSON.parse(execFileSync('python3', ['-c',
    'import json,sys;from pathlib import Path;from cnc_telegram_worker.vector import parse_svg_cut_layout,layout_to_dict;print(json.dumps(layout_to_dict(parse_svg_cut_layout(Path(sys.argv[1])))))',
    resolve('tests/fixtures/svg-source-priority', file)], {
    env: { ...process.env, PYTHONPATH: resolve('cnc-telegram-worker') }, encoding: 'utf8',
  }));
}

type Snapshot = { groups: Array<{ sheets: Array<{ placements: any; renderSnapshot: any }> }> };

describe.skipIf(!url)('SVG import writer with contract v2 (migration 231)', () => {
  let pool: Pool;
  let database: DatabaseService;
  let repo: PgCncTelegramRepository;
  let userId: string;
  // The contract switch as it was before the test; restored afterwards.
  let originalSwitch: unknown = undefined;

  async function restoreSwitch() {
    if (originalSwitch === undefined) {
      await pool.query('DELETE FROM cut_settings WHERE key = $1', [RENDER_SNAPSHOT_CONTRACT_SETTING_KEY]);
    } else {
      await pool.query(
        `INSERT INTO cut_settings (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [RENDER_SNAPSHOT_CONTRACT_SETTING_KEY, JSON.stringify(originalSwitch)],
      );
    }
    const now = (await pool.query<{ value: unknown }>(
      'SELECT value FROM cut_settings WHERE key = $1', [RENDER_SNAPSHOT_CONTRACT_SETTING_KEY],
    )).rows[0]?.value;
    expect(now).toEqual(originalSwitch);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 });
    const databaseName = (await pool.query<{ name: string }>('SELECT current_database() AS name')).rows[0].name;
    if (!DISPOSABLE_CLONE.test(databaseName)) {
      throw new Error(`Refusing to write E2E rows into ${databaseName}: only a cut_golden_run_* clone is allowed`);
    }
    originalSwitch = (await pool.query<{ value: unknown }>(
      'SELECT value FROM cut_settings WHERE key = $1', [RENDER_SNAPSHOT_CONTRACT_SETTING_KEY],
    )).rows[0]?.value;
    database = new DatabaseService(
      new ConfigService<BackendEnv, true>({
        DATABASE_URL: url, DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 2, DATABASE_SSL: false, DATABASE_QUERY_TIMEOUT_MS: 60000,
      } as never),
      { measure: (_text: string, run: () => unknown) => run() } as never,
    );
    repo = new PgCncTelegramRepository(database);
    userId = String((await pool.query(`SELECT user_id FROM users WHERE username = 'codex_playwright'`)).rows[0].user_id);
  });

  afterAll(async () => {
    try {
      if (repo) await restoreSwitch();
    } finally {
      await database?.onModuleDestroy();
      await pool?.end();
    }
  });

  async function upload(file: string) {
    const layout = layoutOf(file);
    const items = layout.items.map((item, i) => ({
      sourceItemKey: `item-${i}`, orderName: item.orderName, detailNumber: item.detailNumber,
      widthMm: item.widthMm, heightMm: item.heightMm, quantity: 1, source: 'vector', confidence: 0.99,
    }));
    // The fixtures are real machine files: their orders and details exist in the copied data.
    const orderNames = [...new Set(layout.items.map((item) => item.orderName))];
    const selectedOrderIds = (await pool.query<{ order_id: string }>(
      `SELECT order_id FROM orders
        WHERE order_name = ANY($1::text[]) AND order_kind = 'production_order' AND delete_flag = false
        ORDER BY order_id`,
      [orderNames],
    )).rows.map((row) => Number(row.order_id));
    expect(selectedOrderIds.length).toBeGreaterThan(0);
    const programName = `E2E-render-v2-${randomUUID().slice(0, 8)}.svg`;
    const dto = parseManualSvgUpload({
      selectedOrderIds, createMdfMachineFileCard: false,
      svgContentHash: createHash('sha256').update(randomUUID()).digest('hex'),
      programName, cutLayout: layout, items,
    }, randomUUID());
    const response = await repo.manualSvgUpload({
      currentUser: { id: userId, username: 'codex_playwright', role: 'admin', permissions: ['cut.manage', 'cut.view', 'orders.view'] } as never,
      dto,
      requestId: `E2E-render-v2-${randomUUID()}`,
    });
    expect(response.cutResultId, JSON.stringify({ ...response, packet: undefined }).slice(0, 1500)).not.toBeNull();
    const row = (await pool.query<{ snapshot_job: Snapshot; snapshot_manifest: any }>(
      'SELECT snapshot_job, snapshot_manifest FROM cut_result WHERE cut_result_id = $1', [response.cutResultId],
    )).rows[0];
    const maps = (await pool.query<{ base_svg: string | null }>(
      'SELECT base_svg FROM cut_result_sheet_map WHERE cut_result_id = $1 ORDER BY sheet_index', [response.cutResultId],
    )).rows;
    return { row, maps, programName };
  }

  // stale-comment-size.svg is one order's real machine file and makes a cut job; the multi-order
  // mixed fixture is applied without a cut job (no single cuttable plan), so it has no result to
  // compare here — its twelve views are covered by svg-render-snapshot-v2.test.ts.
  it.each(['stale-comment-size.svg'])(
    'stores v2 by default, v1 when switched back, and both draw the same views: %s', async (file) => {
      let v2: Awaited<ReturnType<typeof upload>>;
      let v1: Awaited<ReturnType<typeof upload>>;
      try {
        await pool.query('DELETE FROM cut_settings WHERE key = $1', [RENDER_SNAPSHOT_CONTRACT_SETTING_KEY]);
        v2 = await upload(file);
        await pool.query(
          `INSERT INTO cut_settings (key, value) VALUES ($1, '{"contract":"v1"}'::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [RENDER_SNAPSHOT_CONTRACT_SETTING_KEY],
        );
        v1 = await upload(file);
      } finally {
        await restoreSwitch();
      }

      const v2Sheet = v2.row.snapshot_job.groups[0].sheets[0];
      const v1Sheet = v1.row.snapshot_job.groups[0].sheets[0];
      expect(v2Sheet.renderSnapshot.contractVersion).toBe('cut_sheet_render_v2');
      expect(v1Sheet.renderSnapshot.contractVersion).toBe('cut_sheet_render_v1');
      expect(v2.row.snapshot_manifest.variants[0].renderContract).toBe('cut_sheet_render_v2');
      expect(v1.row.snapshot_manifest.variants[0].renderContract).toBe('cut_sheet_render_v1');
      // The label-map projection copied the one stored view.
      expect(v2.maps[0].base_svg).toBe(v2Sheet.renderSnapshot.views[FROZEN_SHEET_STORED_VIEW_KEY].svg);
      expect(v1.maps[0].base_svg).toBe(v1Sheet.renderSnapshot.views[FROZEN_SHEET_STORED_VIEW_KEY].svg);
      // Same layout, same order: the two results describe the same sheet.
      expect(v2Sheet.placements).toEqual(v1Sheet.placements);
      // Each upload is its own machine file; apart from that name the PDF data is the same.
      const named = (value: unknown, programName: string) => JSON.parse(JSON.stringify(value).replaceAll(programName, 'E2E-file.svg'));
      expect(named(v2Sheet.renderSnapshot.pdfMeta, v2.programName)).toEqual(named(v1Sheet.renderSnapshot.pdfMeta, v1.programName));
      expect(named(v2Sheet.renderSnapshot.pdfDetailRows, v2.programName))
        .toEqual(named(v1Sheet.renderSnapshot.pdfDetailRows, v1.programName));
      for (const view of FROZEN_SHEET_VIEWS) {
        expect(renderFrozenSheetView(v2Sheet.placements, v2Sheet.renderSnapshot.model, view), frozenSheetViewKey(view))
          .toEqual(v1Sheet.renderSnapshot.views[frozenSheetViewKey(view)]);
      }
    },
  );
});

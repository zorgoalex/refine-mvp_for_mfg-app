import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { TransactionClient } from '../../../database/database.types';
import {
  changeDetailsProductionStatusFromAutomationInTransaction,
  changeOrderStatusFromAutomationInTransaction,
  changeProductionStatusFromAutomationInTransaction,
  type AutomationActionContext,
} from './pg-production-action-repository';

const statusAutomationMocks = vi.hoisted(() => ({
  evaluateMdfBoardColumnAutomation: vi.fn(),
  evaluateStatusAutomation: vi.fn(),
  evaluateProductionCompositionAutomation: vi.fn(),
}));

vi.mock('../../status-automation/application/status-automation-runtime', () => ({
  evaluateMdfBoardColumnAutomation: statusAutomationMocks.evaluateMdfBoardColumnAutomation,
  evaluateStatusAutomation: statusAutomationMocks.evaluateStatusAutomation,
  evaluateProductionCompositionAutomation: statusAutomationMocks.evaluateProductionCompositionAutomation,
}));

beforeEach(() => {
  statusAutomationMocks.evaluateMdfBoardColumnAutomation.mockReset();
  statusAutomationMocks.evaluateStatusAutomation.mockReset();
  statusAutomationMocks.evaluateProductionCompositionAutomation.mockReset();
});

describe('production-action automation in-transaction actions', () => {
  it('limits a scoped MDF action to eligible source members and preserves every manual move', async () => {
    const database = createAutomationTx({ detailRows: [
      { detail_id: 101, production_status_id: 1, production_status_sort_order: 10 },
      { detail_id: 102, production_status_id: 1, production_status_sort_order: 10 },
    ] });
    const context = { ...automationContext(), eventType: 'mdf.board.completed', mdfBoardScope: {
      source: { kind: 'packet' as const, id: 'file' }, details: [
        { detailId: 101, requiredQuantity: 10, eligibleQuantity: 10 },
        { detailId: 102, requiredQuantity: 10, eligibleQuantity: 4 },
      ],
    } };
    await expect(changeDetailsProductionStatusFromAutomationInTransaction(database.tx, 15, 2, context, 'set_exact'))
      .resolves.toMatchObject({ status: 'executed' });
    expect(database.sql.some(sql => sql.includes('AND detail.detail_id = ANY($2::bigint[])'))).toBe(true);
    expect(database.auditCalls[0]?.metadata).toMatchObject({ changedDetailIds: [101], mdfBoardScope: context.mdfBoardScope });
    expect(database.sql.some(sql => sql.includes('DELETE FROM mdf_board_manual_moves'))).toBe(false);
    expect(statusAutomationMocks.evaluateMdfBoardColumnAutomation).not.toHaveBeenCalled();
  });

  it('rejects direct unscoped MDF batch commands before any database access', async () => {
    const database = createAutomationTx({});
    await expect(changeDetailsProductionStatusFromAutomationInTransaction(database.tx, 15, 2,
      { ...automationContext(), eventType: 'mdf.board.completed' }))
      .resolves.toEqual({ status: 'skipped', skipReason: 'mdf_source_required' });
    expect(database.sql).toEqual([]);
  });
  it('skips an order status action when the target is already current without audit or outbox', async () => {
    const database = createAutomationTx({ orderStatusId: 7 });

    await expect(
      changeOrderStatusFromAutomationInTransaction(database.tx, 15, 7, automationContext()),
    ).resolves.toEqual({ status: 'skipped', skipReason: 'same_status' });

    expect(database.auditCalls).toHaveLength(0);
    expect(database.outboxCalls).toHaveLength(0);
  });

  it('cascades a production status automation action through details even when detail-derived mode is active', async () => {
    const database = createAutomationTx({
      productionStatusFromDetailsEnabled: true,
      detailRows: [
        { detail_id: 101, production_status_id: 1 },
        { detail_id: 102, production_status_id: 2 },
      ],
      updatedDetailIds: [101, 102],
      recalcOrderProductionStatusId: 7,
      mdfLaminatedBathRows: [
        { cut_result_id: 601, order_id: 15 },
        { cut_result_id: 601, order_id: 22 },
      ],
    });

    await expect(
      changeProductionStatusFromAutomationInTransaction(database.tx, 15, 7, automationContext()),
    ).resolves.toMatchObject({ status: 'executed', auditId: 42 });

    expect(database.sql.some((sql) => sql.startsWith('UPDATE order_details'))).toBe(true);
    expect(database.recalcCalls).toEqual([15]);
    expect(database.auditCalls[0]?.metadata).toMatchObject({
      productionStatusFromDetailsEnabled: true,
      affectedDetailCount: 2,
    });
    expect(database.outboxCalls[0]?.payload).toMatchObject({
      productionStatusFromDetailsEnabled: true,
    });
    const call = statusAutomationMocks.evaluateMdfBoardColumnAutomation.mock.calls[0];
    expect(call?.[1]).toMatchObject({
      eventType: 'mdf.board.baths_laminated',
      requestId: 'automation-request-1',
      sourceIdempotencyKey: 'source-key-1:automation:21:mdf-board:bath:cut-result-601:baths_laminated',
    });
    expect(Array.from(call?.[1].orderIds as Iterable<number>)).toEqual([15, 22]);
  });

  it('writes automation metadata and preserves the supplied outbox idempotency key', async () => {
    const database = createAutomationTx({ orderStatusId: 5 });
    const context = automationContext();

    await expect(
      changeOrderStatusFromAutomationInTransaction(database.tx, 15, 7, context),
    ).resolves.toMatchObject({ status: 'executed', auditId: 42 });

    expect(database.auditCalls[0]).toMatchObject({
      event: 'orders.status_change',
      source: 'backend-status-automation',
      metadata: expect.objectContaining({
        ruleId: 21,
        eventType: 'order.status_changed',
      }),
    });
    expect(database.outboxCalls[0]).toMatchObject({
      eventType: 'order.status_changed',
      idempotencyKey: context.outboxIdempotencyKey,
      payload: expect.objectContaining({
        origin: 'automation',
        orderStatusIdBefore: 5,
        orderStatusIdAfter: 7,
      }),
    });
    expect(statusAutomationMocks.evaluateStatusAutomation).toHaveBeenCalledWith(
      database.tx,
      expect.objectContaining({
        eventType: 'order.status_changed',
        origin: 'automation',
        orderStatusIdBefore: 5,
        orderStatusIdAfter: 7,
      }),
    );
  });

  it('skips detail automation when the order has no live details', async () => {
    const database = createAutomationTx({ detailRows: [] });

    await expect(
      changeDetailsProductionStatusFromAutomationInTransaction(database.tx, 15, 7, automationContext()),
    ).resolves.toEqual({ status: 'skipped', skipReason: 'no_details' });

    expect(database.auditCalls).toHaveLength(0);
    expect(database.outboxCalls).toHaveLength(0);
  });

  it('skips detail automation without version bump when every live detail already has the target status', async () => {
    const database = createAutomationTx({
      detailRows: [
        { detail_id: 101, production_status_id: 7 },
        { detail_id: 102, production_status_id: 7 },
      ],
    });

    await expect(
      changeDetailsProductionStatusFromAutomationInTransaction(database.tx, 15, 7, automationContext()),
    ).resolves.toEqual({ status: 'skipped', skipReason: 'same_status' });

    expect(database.auditCalls).toHaveLength(0);
    expect(database.outboxCalls).toHaveLength(0);
    expect(database.sql.some((sql) => sql.startsWith('UPDATE orders'))).toBe(false);
    expect(database.sql.some((sql) => sql.startsWith('UPDATE order_details'))).toBe(false);
  });

  it('locks the order before details and recalculates in details auto mode', async () => {
    const database = createAutomationTx({
      productionStatusFromDetailsEnabled: true,
      detailRows: [
        { detail_id: 102, production_status_id: 1 },
        { detail_id: 101, production_status_id: 2 },
      ],
      updatedDetailIds: [101, 102],
    });

    await expect(
      changeDetailsProductionStatusFromAutomationInTransaction(database.tx, 15, 7, automationContext()),
    ).resolves.toMatchObject({ status: 'executed', auditId: 42 });

    const orderLockIndex = database.sql.findIndex((sql) => sql.includes('FROM orders') && sql.includes('FOR UPDATE'));
    const detailLockIndex = database.sql.findIndex((sql) => sql.includes('FROM order_details') && sql.includes('FOR UPDATE'));
    const detailUpdateIndex = database.sql.findIndex((sql) => sql.startsWith('UPDATE order_details'));
    expect(orderLockIndex).toBeGreaterThanOrEqual(0);
    expect(detailLockIndex).toBeGreaterThan(orderLockIndex);
    expect(detailUpdateIndex).toBeGreaterThan(detailLockIndex);
    expect(database.recalcCalls).toEqual([15]);
  });

  it('advance-only detail cascade never selects details above the target status', async () => {
    const database = createAutomationTx({
      targetProductionSortOrder: 50,
      detailRows: [
        { detail_id: 101, production_status_id: 1, production_status_sort_order: 20 },
        { detail_id: 102, production_status_id: 8, production_status_sort_order: 80 },
      ],
      updatedDetailIds: [101],
    });

    await expect(changeDetailsProductionStatusFromAutomationInTransaction(
      database.tx,
      15,
      7,
      automationContext(),
      'advance_only',
    )).resolves.toMatchObject({ status: 'executed' });

    const updateIndex = database.sql.findIndex((sql) => sql.startsWith('UPDATE order_details'));
    expect(database.sql[updateIndex]).toContain("$4::text = 'set_exact'");
    expect(database.sql.some((sql) => sql.includes('DELETE FROM mdf_board_manual_moves'))).toBe(true);
    expect(database.auditCalls[0]?.metadata).toMatchObject({ affectedDetailCount: 1 });
  });

  it('emits MDF-board laminated automation after a detail-status automation action', async () => {
    const database = createAutomationTx({
      detailRows: [
        { detail_id: 102, production_status_id: 1 },
        { detail_id: 101, production_status_id: 2 },
      ],
      updatedDetailIds: [101],
      mdfLaminatedBathRows: [{ cut_result_id: 701, order_id: 15 }],
    });

    await expect(
      changeDetailsProductionStatusFromAutomationInTransaction(database.tx, 15, 7, automationContext()),
    ).resolves.toMatchObject({ status: 'executed', auditId: 42 });

    const call = statusAutomationMocks.evaluateMdfBoardColumnAutomation.mock.calls[0];
    expect(call?.[1]).toMatchObject({
      eventType: 'mdf.board.baths_laminated',
      requestId: 'automation-request-1',
      sourceIdempotencyKey: 'source-key-1:automation:21:mdf-board:bath:cut-result-701:baths_laminated',
    });
    expect(Array.from(call?.[1].orderIds as Iterable<number>)).toEqual([15]);
  });

  it('checks explicit MDF and all packet material metadata before counting laminated bath quantities', async () => {
    const database = createAutomationTx({ updatedDetailIds: [101] });
    await changeDetailsProductionStatusFromAutomationInTransaction(database.tx, 15, 7, automationContext());

    const query = database.sql.find((sql) => sql.startsWith('WITH laminated_status_threshold AS'));
    expect(query).toBeDefined();
    expect(query).toContain("COALESCE(p.material_name, '') ~* '(mdf|мдф)'");
    for (const field of ['material_name', 'program_name', 'external_packet_key']) {
      expect(query).toContain(`COALESCE(p.${field}, '') !~*`);
    }
    expect(query).toContain("jsonb_array_elements_text(COALESCE(p.comments_json, '[]'::jsonb))");
    expect(query).not.toContain('LIKE ANY');
    expect(query).toContain("packet.completion_status = 'completed' OR packet.thumbs_up = true");
    expect(query).toContain('candidate.completed_quantity < candidate.quantity');
    expect(query).toContain('candidate.laminated_or_later = false');
  });

  // Opt-in stage SQL smoke: all relations are temporary, no public-table writes.
  it.runIf(process.env.MDF_MATERIAL_STAGE_SQL_TEST === '1')(
    'evaluates real PostgreSQL bath quantities with filename material and unchanged status guards', async () => {
      const database = createAutomationTx({ updatedDetailIds: [101] });
      await changeDetailsProductionStatusFromAutomationInTransaction(database.tx, 15, 7, automationContext());
      const query = database.sql.find((sql) => sql.startsWith('WITH laminated_status_threshold AS'));
      expect(query).toBeDefined();
      const cases: Array<{ name: string; update: string; eligible: boolean }> = [
        { name: 'default MDF', update: '', eligible: true },
        ...['fanera18', 'LDSP16', 'hdf3', 'khdf3', 'xdf3', 'dsp16', 'dvp3', 'osb12', 'osp12', 'akril4', 'plastik4', 'plywood18'].map((name) => ({
          name: `filename ${name}`,
          update: `UPDATE cnc_telegram_packets SET program_name = '2701_${name}mm.tap' WHERE packet_id = 1;`,
          eligible: false,
        })),
        ...['МДФ 10мм', 'MDF16mm', 'ЛМДФ 18мм', 'new-MDF-type'].map((name) => ({
          name,
          update: `UPDATE cnc_telegram_packets SET material_name = '${name}';`,
          eligible: true,
        })),
        { name: 'comment overrides MDF', update: `UPDATE cnc_telegram_packets SET comments_json = '["фанера 18мм"]' WHERE packet_id = 1;`, eligible: false },
        { name: 'external key overrides MDF', update: `UPDATE cnc_telegram_packets SET external_packet_key = '2701_fanera18' WHERE packet_id = 1;`, eligible: false },
        { name: 'explicit plywood', update: `UPDATE cnc_telegram_packets SET material_name = 'Фанера 18мм' WHERE packet_id = 1;`, eligible: false },
        { name: 'unknown material', update: `UPDATE cnc_telegram_packets SET material_name = 'Не определён' WHERE packet_id = 1;`, eligible: false },
        { name: 'empty material', update: `UPDATE cnc_telegram_packets SET material_name = '' WHERE packet_id = 1;`, eligible: false },
        { name: 'null material', update: `UPDATE cnc_telegram_packets SET material_name = NULL WHERE packet_id = 1;`, eligible: false },
        { name: 'null optional fields', update: `UPDATE cnc_telegram_packets SET program_name = NULL, comments_json = NULL;`, eligible: true },
        { name: 'pending', update: `UPDATE cnc_telegram_packets SET completion_status = 'pending' WHERE packet_id = 1;`, eligible: false },
        { name: 'thumbs up', update: `UPDATE cnc_telegram_packets SET completion_status = 'pending', thumbs_up = true WHERE packet_id = 1;`, eligible: true },
        { name: 'thumbs up cannot bypass material', update: `UPDATE cnc_telegram_packets SET completion_status = 'pending', thumbs_up = true, program_name = '2701_fanera18.tap' WHERE packet_id = 1;`, eligible: false },
        { name: 'insufficient quantity', update: `UPDATE cnc_telegram_packet_items SET quantity = 1 WHERE packet_id = 1;`, eligible: false },
        { name: 'unmatched item', update: `UPDATE cnc_telegram_packet_items SET match_detail_id = NULL, match_status = 'needs_review' WHERE packet_id = 1;`, eligible: false },
        { name: 'not laminated', update: `UPDATE order_details SET production_status_id = 1 WHERE detail_id = 101;`, eligible: false },
        { name: 'another bath detail not laminated', update: `UPDATE order_details SET production_status_id = 1 WHERE detail_id = 102;`, eligible: false },
      ];
      const fixture = `
        BEGIN;
        SET LOCAL search_path = pg_temp;
        SET LOCAL statement_timeout = '5s';
        CREATE TEMP TABLE production_statuses (production_status_id int, production_status_code text, production_status_name text, sort_order int);
        CREATE TEMP TABLE cut_result (cut_result_id bigint, cut_job_id bigint, result_no int, revision_no int, created_at timestamptz, snapshot_job jsonb);
        CREATE TEMP TABLE cut_result_placement (cut_result_id bigint, order_id bigint, order_detail_id bigint);
        CREATE TEMP TABLE cut_job (cut_job_id bigint, current_cut_result_id bigint, param_profile_id bigint, status text, params jsonb);
        CREATE TEMP TABLE cut_param_profiles (cut_param_profile_id bigint, params jsonb);
        CREATE TEMP TABLE cut_result_archive_state (cut_job_id bigint, result_no int, archived_at timestamptz);
        CREATE TEMP TABLE orders (order_id bigint, delete_flag boolean, order_name text, order_kind text, order_status_id int, production_status_id int);
        CREATE TEMP TABLE order_details (detail_id bigint, production_status_id int, delete_flag boolean, order_id bigint, detail_number int, width numeric, height numeric);
        CREATE TEMP TABLE cnc_telegram_packets (packet_id int, material_name text, program_name text, external_packet_key text, comments_json jsonb, completion_status text, thumbs_up boolean,
          rework boolean, mdf_board_card_kind text, mdf_board_hidden_at timestamptz, source_chat_id text, source_version int);
        CREATE TEMP TABLE cnc_telegram_packet_items (packet_id int, match_detail_id bigint, quantity int, match_status text,
          match_order_id bigint, order_name text, detail_number int, width_mm numeric, height_mm numeric, source text);
        CREATE TEMP TABLE mdf_board_manual_moves AS TABLE public.mdf_board_manual_moves WITH NO DATA;
        CREATE TEMP TABLE bazis_cut_sets AS TABLE public.bazis_cut_sets WITH NO DATA;
        CREATE TEMP TABLE bazis_cut_set_details AS TABLE public.bazis_cut_set_details WITH NO DATA;
        CREATE TEMP TABLE order_statuses AS TABLE public.order_statuses WITH NO DATA;
        CREATE TEMP TABLE app_settings AS TABLE public.app_settings WITH NO DATA;
        CREATE TEMP TABLE cnc_telegram_packet_whole_order_keys (packet_id int, order_key text);
        CREATE TEMP TABLE outbox_events AS TABLE public.outbox_events WITH NO DATA;
        INSERT INTO production_statuses VALUES (1, 'cut', 'Крой', 10), (7, 'laminated', 'Закатан', 30);
        INSERT INTO cut_result VALUES (701, 70, 1, 1, now(), '{}');
        INSERT INTO cut_result_placement VALUES (701, 15, 101), (701, 15, 101), (701, 15, 102);
        INSERT INTO cut_job VALUES (70, 701, NULL, 'active', '{"layout_mode":"vacuum_table"}');
        INSERT INTO orders(order_id,delete_flag,order_name,order_kind) VALUES (15, false, 'E2E-Test', 'production_order');
        INSERT INTO order_details(detail_id,production_status_id,delete_flag,order_id) VALUES (101, 7, false, 15), (102, 7, false, 15);
        INSERT INTO cnc_telegram_packets (packet_id) VALUES (1), (2);
        INSERT INTO cnc_telegram_packet_items(packet_id,match_detail_id,quantity,match_status,match_order_id)
          VALUES (1, 101, 2, 'matched', 15), (2, 102, 2, 'matched', 15);
        ${cases.map(({ update }) => `
          UPDATE cnc_telegram_packets SET material_name = 'МДФ 16мм', program_name = '2701_MDF16.tap',
            external_packet_key = 'telegram:test:1', comments_json = '[]', completion_status = 'completed', thumbs_up = false;
          UPDATE cnc_telegram_packet_items SET quantity = 2, match_status = 'matched', match_detail_id = 100 + packet_id;
          UPDATE order_details SET production_status_id = 7;
          ${update}
          SELECT count(*) FROM (${query!.replace('$1', 'ARRAY[101]')}) AS eligible_baths;
        `).join('\n')}
        ROLLBACK;
      `;
      const output = execFileSync('rtk', [
        'docker', 'exec', '-i', 'erp_test-postgresdb-1', 'sh', '-c',
        'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
      ], { input: fixture, encoding: 'utf8', timeout: 30_000 });
      const counts = output.trim().split('\n');
      expect(counts).toHaveLength(cases.length);
      cases.forEach((testCase, index) => {
        expect(counts[index], testCase.name).toBe(testCase.eligible ? '1' : '0');
      });
    }, 35_000,
  );
});

interface AutomationTxOptions {
  orderStatusId?: number;
  productionStatusId?: number | null;
  productionStatusFromDetailsEnabled?: boolean;
  detailRows?: Array<{
    detail_id: number;
    production_status_id: number | null;
    production_status_sort_order?: number | null;
  }>;
  targetProductionSortOrder?: number;
  updatedDetailIds?: number[];
  recalcOrderProductionStatusId?: number;
  mdfLaminatedBathRows?: Array<{ cut_result_id: number | string; order_id: number | string }>;
}

interface AutomationTxState {
  tx: TransactionClient;
  sql: string[];
  auditCalls: Array<{ event: unknown; source: unknown; metadata: Record<string, unknown> }>;
  outboxCalls: Array<{
    eventType: unknown;
    idempotencyKey: unknown;
    payload: Record<string, unknown>;
  }>;
  recalcCalls: number[];
}

function createAutomationTx(options: AutomationTxOptions = {}): AutomationTxState {
  const sql: string[] = [];
  const auditCalls: AutomationTxState['auditCalls'] = [];
  const outboxCalls: AutomationTxState['outboxCalls'] = [];
  const recalcCalls: number[] = [];
  const detailRows = options.detailRows ?? [{ detail_id: 101, production_status_id: 1 }];

  const tx = {
    async query<T extends object>(text: string, params: readonly unknown[] = []) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      sql.push(normalized);

      if (normalized.includes('FROM orders') && normalized.includes('FOR UPDATE')) {
        return {
          rows: [{
            order_id: 15,
            client_id: 969,
            order_date: '2026-05-01',
            planned_completion_date: '2026-05-10',
            order_status_id: options.orderStatusId ?? 5,
            payment_status_id: 1,
            production_status_id: options.productionStatusId ?? 1,
            production_status_from_details_enabled: options.productionStatusFromDetailsEnabled ?? false,
            version: 3,
            created_by: 1,
            manager_id: null,
          } as T],
        };
      }
      if (normalized.startsWith('SELECT order_status_id, order_status_name')) {
        return { rows: [{ order_status_id: params[0], order_status_name: 'Выдан' } as T] };
      }
      if (normalized.startsWith('SELECT production_status_id, production_status_name')) {
        return { rows: [{
          production_status_id: params[0],
          production_status_name: 'Крой',
          production_status_code: 'cut',
          sort_order: options.targetProductionSortOrder ?? 50,
        } as T] };
      }
      if (normalized.includes('FROM order_details') && normalized.includes('FOR UPDATE')) {
        return { rows: (normalized.includes('detail.detail_id = ANY($2::bigint[])')
          ? detailRows.filter(row => (params[1] as number[]).includes(row.detail_id)) : detailRows) as T[] };
      }
      if (normalized.startsWith('UPDATE order_details')) {
        return { rows: (options.updatedDetailIds ?? detailRows.map((row) => row.detail_id))
          .filter(id => !normalized.includes('detail_id = ANY($3::bigint[])') || (params[2] as number[]).includes(id))
          .map((detail_id) => ({ detail_id } as T)) };
      }
      if (normalized.startsWith('UPDATE orders SET order_status_id')) {
        return { rows: [{ version: 4 } as T] };
      }
      if (normalized.startsWith('UPDATE orders SET production_status_id')) {
        return {
          rows: [{
            version: 4,
            production_status_id:
              options.recalcOrderProductionStatusId ?? params[2] ?? options.productionStatusId ?? 1,
          } as T],
        };
      }
      if (normalized.startsWith('UPDATE orders SET production_status_from_details_enabled = true')) {
        return {
          rows: [{
            version: 4,
            production_status_id:
              options.recalcOrderProductionStatusId ?? options.productionStatusId ?? 1,
          } as T],
        };
      }
      if (normalized.startsWith('UPDATE orders SET version = version + 1')) {
        return { rows: [{ version: 4, production_status_id: options.productionStatusId ?? 1 } as T] };
      }
      if (normalized.startsWith('SELECT recalc_order_production_status')) {
        recalcCalls.push(Number(params[0]));
        return { rows: [] as T[] };
      }
      if (
        normalized.startsWith('WITH laminated_status_threshold AS') &&
        normalized.includes('candidate_vacuum_results')
      ) {
        return { rows: (options.mdfLaminatedBathRows ?? []) as T[] };
      }
      if (normalized.startsWith('INSERT INTO audit_log')) {
        const metadata = JSON.parse(String(params[22])) as Record<string, unknown>;
        auditCalls.push({ event: params[0], source: params[7], metadata });
        return { rows: [{ audit_id: 42 } as T] };
      }
      if (normalized.startsWith('INSERT INTO outbox_events')) {
        outboxCalls.push({
          eventType: params[0],
          idempotencyKey: params[4],
          payload: JSON.parse(String(params[3])) as Record<string, unknown>,
        });
        return { rows: [] as T[] };
      }
      return { rows: [] as T[] };
    },
  };

  return {
    tx: tx as unknown as TransactionClient,
    sql,
    auditCalls,
    outboxCalls,
    recalcCalls,
  };
}

function automationContext(): AutomationActionContext {
  return {
    actor: currentUser(),
    requestId: 'automation-request-1',
    ruleId: 21,
    ruleName: 'После выдачи',
    eventType: 'order.status_changed',
    outboxIdempotencyKey: 'source-key-1:automation:21',
  };
}

function currentUser(): CurrentUser {
  return {
    id: '1',
    username: 'automation-user',
    role: 'admin',
    roleId: 1,
    permissions: [],
  };
}

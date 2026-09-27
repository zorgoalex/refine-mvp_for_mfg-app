/** §5.7a real-PostgreSQL integration: the read-only legacy reconciliation report end to end
 * (loader + shadow parity + domain classification/allocation) against an isolated schema. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { observeMdfShadowCommand } from '../application/mdf-shadow';
import { runMdfReconciliation } from '../application/mdf-reconciliation-report';
import type { MdfReconciliationKind } from '../domain/mdf-reconciliation';
import { createMdfCorrectionPgFixture } from './mdf-correction-test-fixture.integration';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

const TABLES = [
  'orders', 'order_details', 'order_statuses', 'production_statuses', 'materials', 'sheet_material_types',
  'cnc_telegram_packets', 'cnc_telegram_packet_items', 'cnc_telegram_packet_whole_order_keys',
  'mdf_board_manual_moves', 'mdf_board_history_events', 'status_automation_rules',
  'bazis_cut_sets', 'bazis_cut_set_details',
  'cut_job', 'cut_group', 'cut_group_sheet',
  'cut_result', 'cut_result_board_projection', 'cut_result_placement', 'cut_result_sheet_map',
  'cut_result_archive_state', 'cut_result_label_map_projection',
  'audit_log', 'app_settings', 'outbox_events',
];

describe.skipIf(!enabled)('MDF legacy history reconciliation report, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e179recon');
  let orderSeq = 0, moveSeq = 0, cutResultSeq = 100000, placementSeq = 0, historySeq = 0, basisSeq = 0;
  let database: ReturnType<typeof fixture.createDatabaseService>;

  beforeAll(async () => {
    // Real strict-proof provenance (mdf_shadow_commands) is written by the actual production
    // path (`observeMdfShadowCommand`), gated by this flag, exactly like mdf-shadow.integration.test.ts.
    vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE', 'true');
    await fixture.connect();
    // Same full engine migration set as mdf-shadow.integration.test.ts: `observeMdfShadowCommand`'s
    // real write path (recordMdfReceipt -> mdf_revision_presentation etc.) needs the whole stack,
    // not just the tables the reconciliation loader itself reads.
    for (const file of ['165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql',
      '167_mdf_shadow_observations.sql', '171_mdf_shadow_commands.sql', '174_mdf_execution_context.sql',
      '175_mdf_command_placement.sql', '178_mdf_correction_receipts.sql', '188_mdf_order_cascade_intents.sql',
      '189_mdf_placement_inputs.sql', '190_mdf_bath_transitions.sql', '191_mdf_order_corrections.sql',
      '192_mdf_board_presentation_history.sql', '195_mdf_baseline_population.sql']) {
      await fixture.applyMigrations([file]);
    }
    await fixture.clonePublicTables(TABLES);
    await fixture.client.query(`
      INSERT INTO order_statuses(order_status_id,order_status_name,sort_order,is_active)
        VALUES(1,'В производстве',10,true),(2,'Готов к выдаче',20,true),(3,'Выдан',30,true);
      INSERT INTO production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'drawn','Отрисован',10,true),(2,'cut','Распилен',50,true),(3,'laminated','Закатан',70,true),
          (4,'packed','Упакован',80,true),(5,'issued','Выдан',90,true);
      INSERT INTO materials(material_id,material_name) VALUES(1,'МДФ фасад 10 мм'),(2,'ЛДСП 16мм');
    `);
    database = fixture.createDatabaseService();
  }, 30000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.onModuleDestroy();
    await fixture.drop();
  });

  async function seedOrder(opts: { deleted?: boolean; orderStatusId?: number; materialId?: number;
    productionStatusId?: number } = {}) {
    const orderId = ++orderSeq;
    const detailId = orderId * 10 + 1;
    await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,
      order_status_id,payment_status_id,created_by) VALUES($1,$2,'production_order',$3,1,$4,1,1)`,
    [orderId, `E2E recon ${orderId}`, opts.deleted ?? false, opts.orderStatusId ?? 1]);
    await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,
      production_status_id,delete_flag,material_id) VALUES($1,$2,1,10,$3,false,$4)`,
    [detailId, orderId, opts.productionStatusId ?? 2, opts.materialId ?? 1]);
    return { orderId, detailId };
  }

  /** A BASIS (bazisCutSet) card with one detail row. `sourceOrderId`/`sourceDetailId` model the raw,
   * possibly-unresolved owner reference exactly as `bazis_cut_set_details` stores it. */
  async function seedBasisSet(opts: { sourceOrderId: number | null; sourceDetailId: number | null; quantity: number;
    materialName?: string }) {
    const setId = ++basisSeq;
    await fixture.client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,version,created_at,updated_at)
      VALUES($1,$2,1,now(),now())`, [setId, `E2E BASIS ${setId}`]);
    await fixture.client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_id,bazis_cut_set_detail_id,
      source_order_id,source_order_detail_id,material_name,cut_enabled,quantity,updated_at)
      VALUES($1,$1,$2,$3,$4,true,$5,now())`,
    [setId, opts.sourceOrderId, opts.sourceDetailId, opts.materialName ?? 'МДФ фасад 10 мм', opts.quantity]);
    return { setId: String(setId) };
  }

  /** Records ONE real, strictly-proved shadow command (the actual production write path:
   * `observeMdfShadowCommand`, gated by BACKEND_MDF_SHADOW_INTAKE), backed by a matching audit_log row.
   * The composition digest is computed by the production code from the CURRENT rows of `source` at
   * call time, so it stays valid as long as the composition is not changed afterward. */
  async function observeShadowManualMove(kind: 'bazisCutSet' | 'bath', id: string, targetColumn: string, requestId: string) {
    const auditId = randomUUID();
    await database.transaction(async tx => {
      await tx.query(`INSERT INTO audit_log(audit_id,event,entity_type,entity_id,user_id,request_id,status_code)
        VALUES($1,'mdf_board.manual_move.created','mdf_board_manual_move',$2,1,$3,$4)`,
      [auditId, `${kind}:${id}`, requestId, targetColumn]);
      await observeMdfShadowCommand(tx, { source: { kind, id },
        actor: { id: '1', username: 'e2e-recon', role: 'admin' },
        requestId, sourceIdempotencyKey: requestId },
      { kind: 'manual_move', targetColumn, auditId });
    });
    return auditId;
  }

  interface PacketItemSeed { line: string; orderId: number | null; detailId: number | null; quantity: number; matched?: boolean }
  async function seedPacket(opts: { completed: boolean; returned?: boolean; rework?: boolean;
    materialName?: string; items: PacketItemSeed[] }) {
    const packetId = randomUUID();
    await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,
      source_version,payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,
      mdf_board_card_kind,created_at,updated_at,parse_status,rework,mdf_completion_returned)
      VALUES($1,$2,'E2E','1',$3,CURRENT_DATE,$4,$5,now(),$6,'e2e-recon','machine_file',now(),now(),'parsed',$7,$8)`,
    [packetId, `E2E-recon-${packetId}`, randomUUID(), opts.completed ? 'completed' : 'pending', opts.completed,
      opts.materialName ?? 'МДФ фасад 10 мм', opts.rework ?? false, opts.returned ?? false]);
    for (const item of opts.items) {
      await fixture.client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,
        match_order_id,match_detail_id,match_status,quantity,order_name,detail_number,width_mm,height_mm,source)
        VALUES($1,$2,$3,$4,$5,$6,$7,'E2E item',1,100,200,'manual')`,
      [randomUUID(), packetId, item.line, item.orderId, item.detailId,
        item.matched === false ? 'unmatched' : 'matched', item.quantity]);
    }
    return packetId;
  }

  async function seedManualMove(cardKind: MdfReconciliationKind, cardId: string, targetColumn: string) {
    await fixture.client.query(`INSERT INTO mdf_board_manual_moves(move_id,card_kind,card_id,target_column,
      version,updated_at) VALUES($1,$2,$3,$4,1,now())`, [++moveSeq, cardKind, cardId, targetColumn]);
  }

  async function seedManualMoveAudit(cardKind: MdfReconciliationKind, cardId: string, targetColumn: string, requestId: string) {
    await fixture.client.query(`INSERT INTO audit_log(audit_id,event,entity_type,entity_id,user_id,request_id,status_code)
      VALUES($1,'mdf_board.manual_move.created','mdf_board_manual_move',$2,1,$3,$4)`,
    [randomUUID(), `${cardKind}:${cardId}`, requestId, targetColumn]);
  }

  async function seedVacuumBath(opts: { createdAt: string; placements: { orderId: number; detailId: number; quantity: number }[] }) {
    const cutResultId = ++cutResultSeq;
    const digest = randomUUID().replaceAll('-', '');
    await fixture.client.query(`INSERT INTO cut_result(cut_result_id,created_at,snapshot_digest)
      VALUES($1,$2::timestamptz,$3)`, [cutResultId, opts.createdAt, digest]);
    await fixture.client.query(`INSERT INTO cut_result_board_projection(cut_result_id,snapshot_digest,
      is_vacuum,result_created_at) VALUES($1,$2,true,$3::timestamptz)`, [cutResultId, digest, opts.createdAt]);
    await fixture.client.query(`INSERT INTO cut_result_sheet_map(cut_result_sheet_map_id,cut_result_id,is_effective)
      VALUES($1,$1,true)`, [cutResultId]);
    for (const p of opts.placements) {
      for (let i = 0; i < p.quantity; i++) {
        await fixture.client.query(`INSERT INTO cut_result_placement(cut_result_placement_id,
          cut_result_sheet_map_id,cut_result_id,order_id,order_detail_id) VALUES($1,$2,$2,$3,$4)`,
        [++placementSeq, cutResultId, p.orderId, p.detailId]);
      }
    }
    return { cutResultId, bathId: `cut-result:${cutResultId}` };
  }

  /** subjectId as stored on the history row: raw numeric or already 'cut-result:<id>'-prefixed;
   * the loader normalizes both to the same canonical bath identity. */
  async function seedHistoryEvent(subjectKind: 'bath', subjectId: string, orderId: number) {
    const key = `e2e-recon-hist-${++historySeq}`;
    await fixture.client.query(`INSERT INTO mdf_board_history_events(event_key,correlation_key,step_code,order_id,
      subject_kind,subject_id,event_kind,reason_code,actor_kind,source_event_type,occurred_at)
      VALUES($1,$1,'e2e-recon',$2,$3,$4,'appeared','e2e_recon_test','system','none',now())`,
    [key, orderId, subjectKind, subjectId]);
  }

  it('reconciles a full mixed legacy history read-only, matching every disposition and invariant', async () => {
    // 1. Completed, not returned, not rework packet with an AUDITED manual move
    //    to 'completed': physical proof already covers it, no HISTORY_UNVERIFIED.
    const o1 = await seedOrder();
    const packet1 = await seedPacket({ completed: true, items: [{ line: 'part-1', orderId: o1.orderId, detailId: o1.detailId, quantity: 7 }] });
    await seedManualMove('packet', packet1, 'completed');
    await seedManualMoveAudit('packet', packet1, 'completed', 'e2e-recon-1');

    // 2. NOT completed packet with a bare AUDITED manual move to 'completed':
    //    credited, but zero physical proof -> HISTORY_UNVERIFIED + HISTORY_AUDITED_UNBOUND.
    const o2 = await seedOrder();
    const packet2 = await seedPacket({ completed: false, items: [{ line: 'part-1', orderId: o2.orderId, detailId: o2.detailId, quantity: 4 }] });
    await seedManualMove('packet', packet2, 'completed');
    await seedManualMoveAudit('packet', packet2, 'completed', 'e2e-recon-2');

    // 3. Returned packet: HISTORY_RETURNED, no physical cut.
    const o3 = await seedOrder();
    const packet3 = await seedPacket({ completed: true, returned: true, items: [{ line: 'part-1', orderId: o3.orderId, detailId: o3.detailId, quantity: 6 }] });

    // 4. Rework packet: HISTORY_REWORK, composition without supply.
    const o4 = await seedOrder();
    const packet4 = await seedPacket({ completed: true, rework: true, items: [{ line: 'part-1', orderId: o4.orderId, detailId: o4.detailId, quantity: 3 }] });

    // 5. One matched + one unmatched item: HISTORY_PARTIAL_ITEMS, unresolvedItems lists the unmatched one.
    const o5 = await seedOrder();
    const packet5 = await seedPacket({ completed: true, items: [
      { line: 'part-1', orderId: o5.orderId, detailId: o5.detailId, quantity: 2 },
      { line: 'part-2', orderId: null, detailId: null, quantity: 1, matched: false },
    ] });

    // 6. Only item belongs to a deleted order: blocked HISTORY_OWNER_DELETED.
    const o6 = await seedOrder({ deleted: true });
    const packet6 = await seedPacket({ completed: true, items: [{ line: 'part-1', orderId: o6.orderId, detailId: o6.detailId, quantity: 5 }] });

    // 7. Non-MDF packet (material fails the MDF marker regex): excluded HISTORY_NOT_MDF.
    const o7 = await seedOrder();
    const packet7 = await seedPacket({ completed: true, materialName: 'ЛДСП 16мм',
      items: [{ line: 'part-1', orderId: o7.orderId, detailId: o7.detailId, quantity: 1 }] });

    // 8. A manual move names a bath with no matching cut_result row at all: blocked HISTORY_SOURCE_MISSING.
    const missingBathId = 'cut-result:999999';
    await seedManualMove('bath', missingBathId, 'baths_ready');

    // 9. Two vacuum baths compete for one completed packet's physical supply of the
    //    same detail: reservations never exceed supply, FIFO (older createdAt) wins.
    const o9 = await seedOrder();
    const packet9 = await seedPacket({ completed: true, items: [{ line: 'part-1', orderId: o9.orderId, detailId: o9.detailId, quantity: 5 }] });
    const bathOlder = await seedVacuumBath({ createdAt: '2020-01-01T00:00:00.000Z',
      placements: [{ orderId: o9.orderId, detailId: o9.detailId, quantity: 5 }] });
    const bathYounger = await seedVacuumBath({ createdAt: '2020-06-01T00:00:00.000Z',
      placements: [{ orderId: o9.orderId, detailId: o9.detailId, quantity: 5 }] });

    // 10a. mdf_board_history_events canonicalization: a raw numeric subject_id and an already
    //      'cut-result:'-prefixed subject_id both name the SAME existing bath (no spurious
    //      HISTORY_SOURCE_MISSING, no duplicate identity); a history row for a cut_result that
    //      genuinely does not exist still blocks HISTORY_SOURCE_MISSING.
    const o10 = await seedOrder();
    const bathCanon = await seedVacuumBath({ createdAt: '2021-01-01T00:00:00.000Z',
      placements: [{ orderId: o10.orderId, detailId: o10.detailId, quantity: 3 }] });
    await seedHistoryEvent('bath', bathCanon.bathId, o10.orderId);
    await seedHistoryEvent('bath', String(bathCanon.cutResultId), o10.orderId);
    const missingHistoryBathId = 'cut-result:888888';
    await seedHistoryEvent('bath', '888888', o10.orderId);

    // 10b. Completed MDF packet whose matched, live detail carries a NON-MDF material (the
    //      detail's own material, independent of the packet-level material marker): the item is
    //      outside live MDF demand -> HISTORY_OUTSIDE_MDF_DEMAND, blocked since it is the only item.
    const o11NonMdf = await seedOrder({ materialId: 2 });
    const packetOutsideDemand = await seedPacket({ completed: true,
      items: [{ line: 'part-1', orderId: o11NonMdf.orderId, detailId: o11NonMdf.detailId, quantity: 4 }] });

    // 10c. An issued production order named only by a packet item whose match_order_id is set but
    //      which has no matched detail at all: the order still appears in report.orders with its
    //      full live MDF demand as remaining (zero credited).
    const oIssuedUnmatched = await seedOrder({ orderStatusId: 3 });
    await seedPacket({ completed: true, items: [{ line: 'part-1', orderId: oIssuedUnmatched.orderId,
      detailId: null, quantity: 1, matched: false }] });

    // A1. BASIS card with a REAL, strictly-proved manual_move command to 'completed' (the actual
    //     production write path: `observeMdfShadowCommand`, backed by a matching audit_log row).
    //     Credited with a declared cut line, no HISTORY_UNVERIFIED (the proof already covers it).
    const oA1 = await seedOrder();
    const basisA1 = await seedBasisSet({ sourceOrderId: oA1.orderId, sourceDetailId: oA1.detailId, quantity: 6 });
    await seedManualMove('bazisCutSet', basisA1.setId, 'completed');
    await observeShadowManualMove('bazisCutSet', basisA1.setId, 'completed', 'e2e-recon-a1');

    // A2. A DIFFERENT BASIS card with only a bare audited LEGACY manual move and no strict shadow
    //     proof at all (no mdf_shadow_commands row): HISTORY_UNVERIFIED + HISTORY_AUDITED_UNBOUND, no cut.
    const oA2 = await seedOrder();
    const basisA2 = await seedBasisSet({ sourceOrderId: oA2.orderId, sourceDetailId: oA2.detailId, quantity: 5 });
    await seedManualMove('bazisCutSet', basisA2.setId, 'completed');
    await seedManualMoveAudit('bazisCutSet', basisA2.setId, 'completed', 'e2e-recon-a2');

    // A3. Vacuum bath with a REAL strictly-proved manual_move command to 'baths_laminated', whose
    //     legacy manual-move row is THEN REMOVED entirely (cleared placement): the laminated
    //     declaration credit and engineColumn come from the immutable audited proof alone, never
    //     from the current legacy board placement. Detail rank kept well below the packed/laminated
    //     thresholds so the bath's own full-rolled column force is what decides the column.
    const oA3 = await seedOrder({ productionStatusId: 1 }); // 'drawn' (sort_order 10)
    const bathA3 = await seedVacuumBath({ createdAt: '2022-01-01T00:00:00.000Z',
      placements: [{ orderId: oA3.orderId, detailId: oA3.detailId, quantity: 4 }] });
    await seedManualMove('bath', bathA3.bathId, 'baths_laminated');
    await observeShadowManualMove('bath', bathA3.bathId, 'baths_laminated', 'e2e-recon-a3');
    await fixture.client.query(`DELETE FROM mdf_board_manual_moves WHERE card_kind='bath' AND card_id=$1`,
      [bathA3.bathId]);

    // A4. A BASIS card gets a REAL strict proof command, then its composition is changed afterward
    //     (quantity edited): the proof's frozen digest no longer matches the current composition ->
    //     COMMAND_COMPOSITION_CHANGED, no declaration credited; a manual column still asserting cut
    //     gets HISTORY_UNVERIFIED (the changed proof no longer covers it).
    const oA4 = await seedOrder();
    const basisA4 = await seedBasisSet({ sourceOrderId: oA4.orderId, sourceDetailId: oA4.detailId, quantity: 5 });
    await observeShadowManualMove('bazisCutSet', basisA4.setId, 'completed', 'e2e-recon-a4');
    await fixture.client.query(`UPDATE bazis_cut_set_details SET quantity=9 WHERE bazis_cut_set_id=$1`,
      [Number(basisA4.setId)]);
    await seedManualMove('bazisCutSet', basisA4.setId, 'completed');
    await seedManualMoveAudit('bazisCutSet', basisA4.setId, 'completed', 'e2e-recon-a4-manual');

    // B. A BASIS row names a live, issued production order (source_order_id) but has NO matched
    //    detail at all (source_order_detail_id NULL): the order still appears in report.orders with
    //    its full live MDF demand as remaining (zero credited), same mechanism as 10c but via BASIS.
    const oB = await seedOrder({ orderStatusId: 3 });
    await seedBasisSet({ sourceOrderId: oB.orderId, sourceDetailId: null, quantity: 2 });

    const before = await fixture.snapshot(TABLES);
    // pg_stat_xact_user_tables reports this backend's PENDING (not yet flushed) tuple counters,
    // which persist across autocommitted seed statements until an actual flush happens (normally
    // rate-limited to ~1/s). Force-flush now so the counters below start clean at zero.
    await fixture.client.query('SELECT pg_stat_force_next_flush()');
    await fixture.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    let report: Awaited<ReturnType<typeof runMdfReconciliation>>;
    try {
      report = await runMdfReconciliation(fixture.client, {});
      const xact = await fixture.client.query<{ n: string }>(`SELECT COALESCE(SUM(n_tup_ins+n_tup_upd+n_tup_del),0)::text n
        FROM pg_stat_xact_user_tables WHERE schemaname=$1`, [fixture.schema]);
      expect(xact.rows[0].n).toBe('0');
    } finally {
      await fixture.client.query('ROLLBACK');
    }
    expect(await fixture.snapshot(TABLES)).toEqual(before);

    // C. Repeatability: a second, wholly independent READ ONLY run against the same unchanged data
    // (no writes in between) must reconcile to the exact same report, aside from run-timing fields.
    await fixture.client.query('SELECT pg_stat_force_next_flush()');
    await fixture.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    let report2: Awaited<ReturnType<typeof runMdfReconciliation>>;
    try {
      report2 = await runMdfReconciliation(fixture.client, {});
      const xact2 = await fixture.client.query<{ n: string }>(`SELECT COALESCE(SUM(n_tup_ins+n_tup_upd+n_tup_del),0)::text n
        FROM pg_stat_xact_user_tables WHERE schemaname=$1`, [fixture.schema]);
      expect(xact2.rows[0].n).toBe('0');
    } finally {
      await fixture.client.query('ROLLBACK');
    }
    expect(await fixture.snapshot(TABLES)).toEqual(before);
    const stableView = (r: typeof report) => { const { manifest, ...rest } = r; return rest; };
    expect(stableView(report2)).toEqual(stableView(report));

    const source = (kind: string, id: string) => report.sources.find(s => s.kind === kind && s.id === id);

    // Assertion 1.
    const s1 = source('packet', packet1)!;
    expect(s1.disposition).toBe('credited');
    expect(s1.warnings).not.toContain('HISTORY_UNVERIFIED');
    expect(s1.lines.some(l => l.stage === 'cut' && l.evidence === 'physical' && l.quantity === 7)).toBe(true);

    // Assertion 2.
    const s2 = source('packet', packet2)!;
    expect(s2.disposition).toBe('credited');
    expect(s2.warnings).toEqual(expect.arrayContaining(['HISTORY_UNVERIFIED', 'HISTORY_AUDITED_UNBOUND']));
    expect(s2.lines.some(l => l.stage === 'cut')).toBe(false);
    expect(s2.unverifiedQuantity).toBe(4);

    // Assertion 3.
    const s3 = source('packet', packet3)!;
    expect(s3.disposition).toBe('credited');
    expect(s3.warnings).toContain('HISTORY_RETURNED');
    expect(s3.lines.some(l => l.stage === 'cut')).toBe(false);

    // Assertion 4.
    const s4 = source('packet', packet4)!;
    expect(s4.disposition).toBe('credited');
    expect(s4.warnings).toContain('HISTORY_REWORK');
    expect(s4.lines.some(l => l.stage === 'cut')).toBe(false);

    // Assertion 5.
    const s5 = source('packet', packet5)!;
    expect(s5.disposition).toBe('credited');
    expect(s5.warnings).toContain('HISTORY_PARTIAL_ITEMS');
    expect(s5.unresolvedItems.map(u => u.line)).toEqual(['part-2']);

    // Assertion 6.
    const s6 = source('packet', packet6)!;
    expect(s6.disposition).toBe('blocked');
    expect(s6.reason).toBe('HISTORY_OWNER_DELETED');

    // Assertion 7.
    const s7 = source('packet', packet7)!;
    expect(s7.disposition).toBe('excluded');
    expect(s7.reason).toBe('HISTORY_NOT_MDF');

    // Assertion 8.
    const s8 = source('bath', missingBathId)!;
    expect(s8.disposition).toBe('blocked');
    expect(s8.reason).toBe('HISTORY_SOURCE_MISSING');

    // Assertion 9.
    const s9packet = source('packet', packet9)!;
    const s9older = source('bath', bathOlder.bathId)!;
    const s9younger = source('bath', bathYounger.bathId)!;
    expect(s9packet.disposition).toBe('credited');
    expect(s9older.disposition).toBe('credited');
    expect(s9younger.disposition).toBe('credited');
    expect(s9packet.reservedQuantity).toBe(5);
    expect(s9older.reservedQuantity).toBe(5);
    expect(s9younger.reservedQuantity).toBe(0);

    // Assertion 10a: canonicalized bath identity (raw numeric vs 'cut-result:' prefixed history
    // subject_id) resolves to one single credited bath, never a spurious HISTORY_SOURCE_MISSING;
    // a history row for a genuinely nonexistent cut_result still blocks HISTORY_SOURCE_MISSING.
    const canonMatches = report.sources.filter(s => s.kind === 'bath' && s.id === bathCanon.bathId);
    expect(canonMatches).toHaveLength(1);
    expect(canonMatches[0].disposition).not.toBe('blocked');
    expect(canonMatches[0].reason).not.toBe('HISTORY_SOURCE_MISSING');
    const sMissingHistoryBath = source('bath', missingHistoryBathId)!;
    expect(sMissingHistoryBath.disposition).toBe('blocked');
    expect(sMissingHistoryBath.reason).toBe('HISTORY_SOURCE_MISSING');

    // Assertion 10b: a live detail outside MDF demand blocks with HISTORY_OUTSIDE_MDF_DEMAND.
    const sOutsideDemand = source('packet', packetOutsideDemand)!;
    expect(sOutsideDemand.disposition).toBe('blocked');
    expect(sOutsideDemand.reason).toBe('HISTORY_OUTSIDE_MDF_DEMAND');
    expect(sOutsideDemand.unresolvedItems).toEqual([expect.objectContaining({ reason: 'HISTORY_OUTSIDE_MDF_DEMAND' })]);

    // Assertion 10c: the issued order still surfaces with its full live MDF demand as remaining.
    const orderIssuedUnmatched = report.orders.find(o => o.id === oIssuedUnmatched.orderId)!;
    expect(orderIssuedUnmatched).toBeDefined();
    expect(orderIssuedUnmatched).toMatchObject({ required: 10, creditedCut: 0, creditedRolled: 0, remaining: 10 });

    // Assertion A1: a real strict proof credits a declared cut line, no HISTORY_UNVERIFIED.
    const sA1 = source('bazisCutSet', basisA1.setId)!;
    expect(sA1.disposition).toBe('credited');
    expect(sA1.warnings).not.toContain('HISTORY_UNVERIFIED');
    expect(sA1.lines.some(l => l.stage === 'cut' && l.evidence === 'declaration')).toBe(true);
    expect((report.totals as any).quantities.declaredCut).toBeGreaterThan(0);

    // Assertion A2: the same kind of card with only a bare audited legacy move (no strict proof at
    // all) stays unverified/unbound and credits no cut.
    const sA2 = source('bazisCutSet', basisA2.setId)!;
    expect(sA2.disposition).toBe('credited');
    expect(sA2.warnings).toEqual(expect.arrayContaining(['HISTORY_UNVERIFIED', 'HISTORY_AUDITED_UNBOUND']));
    expect(sA2.lines.some(l => l.stage === 'cut')).toBe(false);

    // Assertion A3: the immutable audited proof credits the laminated declaration and forces the
    // 'baths_laminated' column even though the legacy manual-move row was later removed.
    const sA3 = source('bath', bathA3.bathId)!;
    expect(sA3.manualColumn).toBeNull();
    expect(sA3.lines.some(l => l.stage === 'laminated' && l.evidence === 'declaration' && l.quantity === 4)).toBe(true);
    expect(sA3.engineColumn).toBe('baths_laminated');

    // Assertion A4: a changed composition invalidates the frozen proof (COMMAND_COMPOSITION_CHANGED):
    // no declaration credited, and the still-asserting manual column is unverified.
    const sA4 = source('bazisCutSet', basisA4.setId)!;
    expect(sA4.disposition).toBe('credited');
    expect(sA4.lines.some(l => l.stage === 'cut')).toBe(false);
    expect(sA4.warnings).toContain('HISTORY_UNVERIFIED');

    // Assertion B: a BASIS row naming a live issued order with no matched detail at all still
    // surfaces that order in report.orders with its full live MDF demand as remaining.
    const orderB = report.orders.find(o => o.id === oB.orderId)!;
    expect(orderB).toBeDefined();
    expect(orderB).toMatchObject({ required: 10, creditedCut: 0, creditedRolled: 0, remaining: 10 });

    // Assertion 10: every invariant holds, including shadow-loader parity and the accepted-projection gate.
    for (const invariant of report.invariants) expect(invariant).toMatchObject({ ok: true });
    expect(report.invariants.find(i => i.name === 'shadow_loader_parity')).toMatchObject({ ok: true, detail: [] });
    expect(report.invariants.find(i => i.name === 'allocation_invariants')).toMatchObject({ ok: true, detail: [] });
    expect(report.invariants.find(i => i.name === 'credited_sources_verified_by_projection')).toMatchObject({ ok: true, detail: [] });

    // Assertion 11 (no-writes) was already checked above via the pg_stat_xact_user_tables
    // sum and the before/after snapshot equality around the read-only transaction.
  }, 60000);
});

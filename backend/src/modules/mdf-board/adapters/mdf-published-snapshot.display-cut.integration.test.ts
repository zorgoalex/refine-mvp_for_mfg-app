import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { CurrentUser } from '../../../permissions/current-user';
import { createMdfCorrectionPgFixture } from './mdf-correction-test-fixture.integration';
import { recordMdfReceipt, type MdfReceiptInput } from '../application/mdf-receipt';
import { MdfJobRunner } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { readMdfPublishedSnapshot, type MdfPublishedQuery } from './mdf-published-snapshot';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';
const admin: CurrentUser = { id: '1', username: 'E2E display-cut', role: 'admin', roleId: 1, permissions: ['orders.view'] };

/**
 * §5.8 default display cut: the default card set additionally requires each source's LEGACY display date — packet
 * `workday`, BASIS `bazis_cut_sets.created_at`, bath `cut_result.created_at` (no upper bound) — inside
 * [displayFrom, dateTo]; still inside the two-month `source_created_at` candidate window. `focus` and
 * `searchOrderIds` bypass the cut entirely (§5.6 semantics unchanged); owners/positions/progress are never gated by
 * a card's own display-cut visibility.
 */
describe.skipIf(!enabled)('MDF published snapshot, display cut (§5.8), isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e_mdf_display_cut');
  let database: ReturnType<typeof fixture.createDatabaseService> | undefined;
  let sequence = 0;
  const db = () => { if (!database) throw new Error('MDF_TEST_DATABASE_NOT_READY'); return database; };
  const runner = () => new MdfJobRunner(db(), executeMdfAcceptedJob);

  beforeAll(async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION', 'false');
    vi.stubEnv('BACKEND_ENABLE_NOTIFICATION_ENGINE', 'false');
    await fixture.connect();
    await fixture.clonePublicTables([
      'orders', 'order_details', 'order_hdf_details', 'order_statuses', 'production_statuses', 'materials',
      'sheet_material_types', 'users', 'status_automation_rules', 'outbox_events', 'audit_log', 'audit_log_related_entity',
      'app_settings', 'order_workshops', 'cnc_telegram_packets', 'cnc_telegram_packet_items', 'bazis_cut_sets',
      'bazis_cut_set_details', 'cut_result', 'cut_job', 'cut_result_board_projection', 'cut_result_placement',
      'cut_result_sheet_map', 'mdf_board_manual_moves', 'bazis_order_links', 'order_import_entity_map',
    ]);
    await fixture.client.query('ALTER TABLE cnc_telegram_packets ADD PRIMARY KEY(packet_id)');
    await fixture.applyMigrations([
      '165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql', '174_mdf_execution_context.sql',
      '175_mdf_command_placement.sql', '178_mdf_correction_receipts.sql', '179_mdf_active_return.sql',
      '182_mdf_physical_lineage.sql', '185_mdf_bazis_composition.sql', '187_mdf_bazis_refill_rows.sql',
      '188_mdf_order_cascade_intents.sql', '189_mdf_placement_inputs.sql', '190_mdf_bath_transitions.sql',
      '191_mdf_order_corrections.sql', '192_mdf_board_presentation_history.sql', '195_mdf_baseline_population.sql',
    ]);
    await fixture.client.query(`
      ALTER TABLE audit_log ALTER COLUMN audit_id SET DEFAULT gen_random_uuid();
      ALTER TABLE outbox_events ALTER COLUMN outbox_event_id SET DEFAULT gen_random_uuid();
      UPDATE mdf_engine_state SET mode='active';
      INSERT INTO users(user_id,username,role_id,is_active) VALUES (1,'E2E display-cut',1,true);
      INSERT INTO materials(material_id,material_name) VALUES (1,'МДФ фасад 10 мм');
      INSERT INTO order_statuses(order_status_id,order_status_name,sort_order,is_active) VALUES (1,'В производстве',10,true);
      INSERT INTO production_statuses(production_status_id,production_status_code,production_status_name,sort_order,is_active)
        VALUES(1,'new','Новый',1,true),(2,'cut','Распилен',20,true),(3,'laminated','Закатан',30,true),
          (4,'packed','Упакован',40,true),(5,'issued','Выдан',50,true);
    `);
    for (const name of ['order_production_summary', 'recalc_order_production_status']) {
      const definitions = (await fixture.client.query<{ definition: string }>(`SELECT pg_get_functiondef(p.oid) definition
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1`, [name])).rows;
      for (const { definition } of definitions) await fixture.client.query(definition.replace('FUNCTION public.', `FUNCTION ${fixture.schema}.`));
    }
    database = fixture.createDatabaseService();
  }, 30000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.onModuleDestroy();
    await fixture.drop();
  });

  async function drain() {
    for (let i = 0; i < 20; i += 1) {
      const result = await runner().processOne();
      if (result.status === 'idle') return;
      expect(result.status).toBe('done');
    }
    throw new Error('E2E_DISPLAY_CUT_QUEUE_NOT_DRAINED');
  }

  async function makeOrder() {
    const orderId = ++sequence;
    await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,
      payment_status_id,created_by) VALUES($1,$2,'production_order',false,1,1,1,1)`, [orderId, `E2E-ДК ${orderId}`]);
    const detailId = orderId * 100 + 1;
    await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,
      delete_flag,material_id) VALUES($1,$2,1,10,1,false,1)`, [detailId, orderId]);
    return { orderId, detailId };
  }

  /** Raw packet + an accepted membership receipt. `workday` is the legacy display date under test; `sourceCreatedAt`
   * only has to stay inside the two-month candidate window (default deep inside it). */
  async function packet(o: { orderId: number; detailId: number },
    opts: { workday: string; sourceCreatedAt?: string; hidden?: boolean; manualPlacementColumn?: 'parsed'|'completed'|'completed_laminated' }) {
    const packetId = randomUUID();
    const sourceCreatedAt = opts.sourceCreatedAt ?? '2026-09-20T10:00:00Z';
    await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,
        source_version,payload_hash,workday,completion_status,thumbs_up,material_name,program_name,mdf_board_card_kind,
        created_at,updated_at,source_created_at,parse_status,mdf_board_hidden_at)
      VALUES($1,$2,'E2E','1',1,$3,$4::date,'pending',false,'МДФ фасад 10 мм','CNC#_E2E.nc','machine_file',
        now(),now(),$5::timestamptz,'parsed',$6::timestamptz)`,
    [packetId, `E2E-${packetId.slice(0, 8)}`, packetId, opts.workday, sourceCreatedAt, opts.hidden ? sourceCreatedAt : null]);
    await fixture.client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,
        match_order_id,match_detail_id,match_status,quantity,order_name,detail_number,width_mm,height_mm,source)
      VALUES($1,$2,'part-1',$3,$4,'matched',10,'E2E',1,300,500,'manual')`,
    [randomUUID(), packetId, o.orderId, o.detailId]);
    const input: MdfReceiptInput = { sourceKind: 'packet', sourceId: packetId, revisionKey: 'r1', origin: 'cnc',
      actorUserId: 1, requestId: `E2E display packet ${packetId}`, causeKey: `E2E display packet ${packetId}`,
      expectedFence: null, accept: true, rules: [],
      executionContext: { sourceCreatedAt, displayName: `E2E packet ${packetId.slice(0, 8)}`,
        priorColumn: 'parsed', manualPlacementColumn: opts.manualPlacementColumn ?? null, compositionComplete: true,
        demand: [{ orderId: o.orderId, detailId: o.detailId, quantity: 10 }] },
      lines: [{ lineKey: 'm0', orderId: o.orderId, detailId: o.detailId, quantity: 10, stageCode: 'membership',
        evidenceKind: 'derived', rework: false }] };
    await db().transaction(tx => recordMdfReceipt(tx, input));
    await drain();
    return packetId;
  }

  /** Raw BASIS set + an accepted membership receipt. `createdAt` is the legacy display date under test. */
  async function basisSet(o: { orderId: number; detailId: number }, opts: { createdAt: string; sourceCreatedAt?: string }) {
    const setId = 800000 + (++sequence);
    const sourceCreatedAt = opts.sourceCreatedAt ?? '2026-09-20T00:00:00Z';
    await fixture.client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,version,created_at,updated_at)
      VALUES($1,'E2E набор',1,$2::timestamptz,$2::timestamptz)`, [setId, opts.createdAt]);
    await fixture.client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,sort_order,
        source_type,source_order_id,source_order_detail_id,cut_enabled,material_name,position,cut_length_mm,
        cut_width_mm,quantity,created_at,updated_at)
      VALUES($1,$2,1,'order_detail',$3,$4,true,'МДФ фасад 10 мм','1',600,400,10,now(),now())`,
    [setId * 10 + 1, setId, o.orderId, o.detailId]);
    await db().transaction(tx => recordMdfReceipt(tx, { sourceKind: 'bazisCutSet', sourceId: String(setId), revisionKey: 'r1',
      origin: 'derived', presentation: 'compute', actorUserId: 1, requestId: `E2E display basis ${setId}`,
      causeKey: `E2E display basis ${setId}`, expectedFence: null, accept: true, rules: [],
      executionContext: { sourceCreatedAt, displayName: 'E2E набор', priorColumn: 'parsed', compositionComplete: true,
        demand: [{ orderId: o.orderId, detailId: o.detailId, quantity: 10 }] },
      lines: [{ lineKey: String(setId * 10 + 1), orderId: o.orderId, detailId: o.detailId, quantity: 10,
        stageCode: 'membership', evidenceKind: 'derived', rework: false }] }));
    await drain();
    return String(setId);
  }

  /** Raw bath (cut_result) + an accepted membership receipt. `resultCreatedAt` is the legacy display date under test. */
  async function bath(o: { orderId: number; detailId: number }, opts: { resultCreatedAt: string; sourceCreatedAt?: string }) {
    const resultId = 700000 + (++sequence);
    const bathId = `cut-result:${resultId}`;
    const sourceCreatedAt = opts.sourceCreatedAt ?? '2026-09-20T00:00:00Z';
    await fixture.client.query('INSERT INTO cut_result(cut_result_id,created_at) VALUES($1,$2::timestamptz)',
      [resultId, opts.resultCreatedAt]);
    await db().transaction(tx => recordMdfReceipt(tx, { sourceKind: 'bath', sourceId: bathId, revisionKey: 'r1',
      origin: 'manual', actorUserId: 1, requestId: `E2E display bath ${resultId}`, causeKey: `E2E display bath ${resultId}`,
      expectedFence: null, accept: true, rules: [],
      executionContext: { sourceCreatedAt, displayName: 'E2E bath', priorColumn: 'baths', compositionComplete: true,
        demand: [{ orderId: o.orderId, detailId: o.detailId, quantity: 10 }] },
      lines: [{ lineKey: 'm0', orderId: o.orderId, detailId: o.detailId, quantity: 10, stageCode: 'membership',
        evidenceKind: 'derived', rework: false }] }));
    await drain();
    return bathId;
  }

  /** Exact boundary instant, computed in Postgres with the SAME `date + interval` arithmetic the production query
   * uses (`$date::date + N seconds`) — this test's session timezone need not be UTC for the comparison to line up. */
  async function edge(dateStr: string, offsetSeconds: number) {
    const r = await fixture.client.query<{ v: string }>(
      `SELECT (($1::date) + ($2 || ' seconds')::interval)::timestamptz::text v`, [dateStr, offsetSeconds]);
    return r.rows[0].v;
  }

  const read = (query: MdfPublishedQuery = {}) => readMdfPublishedSnapshot(db(), admin, { dateTo: '2026-09-27', ...query });

  it('packet: shown by its own workday even when source_created_at is older; hidden once workday precedes displayFrom', async () => {
    const recent = await makeOrder();
    // source_created_at deep in the two-month window, but workday recent enough for the default 7-day display cut.
    const recentId = await packet(recent, { workday: '2026-09-25', sourceCreatedAt: '2026-08-01T00:00:00Z' });
    expect((await read()).cards.some(c => c.id === recentId)).toBe(true);
    const old = await makeOrder();
    // Recent source_created_at, but a workday older than the default displayFrom (dateTo-6 = 2026-09-21).
    const oldId = await packet(old, { workday: '2026-09-10', sourceCreatedAt: '2026-09-20T00:00:00Z' });
    expect((await read()).cards.some(c => c.id === oldId)).toBe(false);
    expect((await read({ focus: { kind: 'packet', id: oldId } })).cards.some(c => c.id === oldId)).toBe(true);
    expect((await read({ searchOrderIds: [old.orderId] })).cards.some(c => c.id === oldId)).toBe(true);
  });

  it('BASIS: shown by bazis_cut_sets.created_at even when source_created_at is older; hidden once created_at precedes displayFrom', async () => {
    const recent = await makeOrder();
    const recentId = await basisSet(recent, { createdAt: '2026-09-25T12:00:00Z', sourceCreatedAt: '2026-08-01T00:00:00Z' });
    expect((await read()).cards.some(c => c.id === recentId)).toBe(true);
    const old = await makeOrder();
    const oldId = await basisSet(old, { createdAt: '2026-09-10T00:00:00Z', sourceCreatedAt: '2026-09-20T00:00:00Z' });
    expect((await read()).cards.some(c => c.id === oldId)).toBe(false);
    expect((await read({ searchOrderIds: [old.orderId] })).cards.some(c => c.id === oldId)).toBe(true);
  });

  it('bath: shown by cut_result.created_at with no upper bound; hidden once created_at precedes displayFrom', async () => {
    const future = await makeOrder();
    // cut_result created well after dateTo: still shown (bath has no upper bound) since the accepted revision's own
    // source_created_at stays inside the two-month window.
    const futureId = await bath(future, { resultCreatedAt: '2026-10-15T00:00:00Z', sourceCreatedAt: '2026-09-20T00:00:00Z' });
    expect((await read()).cards.some(c => c.id === futureId)).toBe(true);
    const old = await makeOrder();
    const oldId = await bath(old, { resultCreatedAt: '2026-09-10T00:00:00Z', sourceCreatedAt: '2026-09-20T00:00:00Z' });
    expect((await read()).cards.some(c => c.id === oldId)).toBe(false);
    expect((await read({ searchOrderIds: [old.orderId] })).cards.some(c => c.id === oldId)).toBe(true);
  });

  it('packet boundary: workday=displayFrom and workday=dateTo are both included; workday=dateTo+1 is excluded', async () => {
    const dateTo = '2026-09-27', displayFrom = '2026-09-20';
    const atFromOrder = await makeOrder(), atFrom = await packet(atFromOrder, { workday: displayFrom });
    const atToOrder = await makeOrder(), atTo = await packet(atToOrder, { workday: dateTo });
    const afterOrder = await makeOrder(), after = await packet(afterOrder, { workday: '2026-09-28' });
    const snap = await read({ dateTo, displayFrom });
    expect(snap.cards.some(c => c.id === atFrom)).toBe(true);
    expect(snap.cards.some(c => c.id === atTo)).toBe(true);
    expect(snap.cards.some(c => c.id === after)).toBe(false);
  });

  it('BASIS boundary: created_at at displayFrom(00:00)/dateTo(23:59:59) included; displayFrom-1s/dateTo+1(00:00) excluded', async () => {
    const dateTo = '2026-09-27', displayFrom = '2026-09-20';
    const atFromOrder = await makeOrder(), atFrom = await basisSet(atFromOrder, { createdAt: await edge(displayFrom, 0) });
    const atToOrder = await makeOrder(), atTo = await basisSet(atToOrder, { createdAt: await edge(dateTo, 86399) });
    const beforeOrder = await makeOrder(), before = await basisSet(beforeOrder, { createdAt: await edge(displayFrom, -1) });
    const afterOrder = await makeOrder(), after = await basisSet(afterOrder, { createdAt: await edge(dateTo, 86400) });
    const snap = await read({ dateTo, displayFrom });
    expect(snap.cards.some(c => c.id === atFrom)).toBe(true);
    expect(snap.cards.some(c => c.id === atTo)).toBe(true);
    expect(snap.cards.some(c => c.id === before)).toBe(false);
    expect(snap.cards.some(c => c.id === after)).toBe(false);
  });

  it('bath boundary: created_at=displayFrom included, displayFrom-1s excluded, far future included (no upper bound)', async () => {
    const dateTo = '2026-09-27', displayFrom = '2026-09-20';
    const atFromOrder = await makeOrder(), atFrom = await bath(atFromOrder, { resultCreatedAt: await edge(displayFrom, 0) });
    const beforeOrder = await makeOrder(), before = await bath(beforeOrder, { resultCreatedAt: await edge(displayFrom, -1) });
    const farOrder = await makeOrder(), far = await bath(farOrder, { resultCreatedAt: '2027-01-01T00:00:00Z' });
    const snap = await read({ dateTo, displayFrom });
    expect(snap.cards.some(c => c.id === atFrom)).toBe(true);
    expect(snap.cards.some(c => c.id === before)).toBe(false);
    expect(snap.cards.some(c => c.id === far)).toBe(true);
  });

  it('operator-hidden packet is excluded from the default set but returned by focus and by searchOrderIds', async () => {
    const o = await makeOrder();
    const hiddenId = await packet(o, { workday: '2026-09-25', hidden: true });
    expect((await read()).cards.some(c => c.id === hiddenId)).toBe(false);
    expect((await read({ focus: { kind: 'packet', id: hiddenId } })).cards.some(c => c.id === hiddenId)).toBe(true);
    expect((await read({ searchOrderIds: [o.orderId] })).cards.some(c => c.id === hiddenId)).toBe(true);
  });

  it('a terminal-column card older than displayFrom is excluded by default but found (with its column) via searchOrderIds', async () => {
    const o = await makeOrder();
    const id = await packet(o, { workday: '2026-08-01', manualPlacementColumn: 'completed' });
    expect((await read()).cards.some(c => c.id === id)).toBe(false);
    const found = (await read({ searchOrderIds: [o.orderId] })).cards.find(c => c.id === id);
    expect(found).toMatchObject({ column: 'completed' });
  });

  it('positions for an owner stay complete whether its card is display-cut-hidden or shown', async () => {
    const o = await makeOrder();
    const id = await packet(o, { workday: '2026-08-01' }); // excluded by the default display cut
    const hidden = await read({ orderIds: [o.orderId] });
    expect(hidden.cards.some(c => c.id === id)).toBe(false);
    const hiddenPosition = hidden.positions.find(p => p.orderId === o.orderId);
    expect(hiddenPosition).toMatchObject({ detailId: o.detailId, required: 10 });
    const shown = await read({ searchOrderIds: [o.orderId] });
    expect(shown.cards.some(c => c.id === id)).toBe(true);
    expect(shown.positions.find(p => p.orderId === o.orderId)).toEqual(hiddenPosition);
  });

  it('displayFrom is clamped to the two-month candidate window', async () => {
    const dateTo = '2026-09-27';
    const wide = await read({ dateTo, displayFrom: '2000-01-01' });
    expect(wide.displayFrom).toBe(wide.dateFrom);
    const narrow = await read({ dateTo, displayFrom: '2099-01-01' });
    expect(narrow.displayFrom).toBe(dateTo);
  });

  it('rows excluded by the display cut never count toward the 422 card limit; only visible rows can trigger it', async () => {
    const dateTo = '2026-09-27', displayFrom = '2026-09-21';
    // 1500 raw packets with a workday well before displayFrom: candidates for the two-month window, but the
    // per-kind display check must drop every one of them before the LIMIT 1001 page clause ever sees them.
    const hiddenIds = Array.from({ length: 1500 }, () => randomUUID());
    await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,
        source_message_id,source_version,payload_hash,workday,completion_status,thumbs_up,material_name,program_name,
        mdf_board_card_kind,created_at,updated_at,source_created_at,parse_status)
      SELECT id,'E2E-hidden-'||row_number() OVER (),'E2E','1',1,id::text,'2026-08-01'::date,'pending',false,
        'МДФ фасад 10 мм','CNC#_hidden.nc','machine_file',now(),now(),'2026-09-20T00:00:00Z'::timestamptz,'parsed'
      FROM unnest($1::uuid[]) id`, [hiddenIds]);
    await fixture.client.query('SET session_replication_role=replica');
    try {
      await fixture.client.query(`INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,
          accepted_revision_key,correction_epoch,version,updated_at)
        SELECT 'packet',id::text,'1','1',0,1,now() FROM unnest($1::uuid[]) id`, [hiddenIds]);
      await fixture.client.query(`INSERT INTO mdf_published_sources(source_kind,source_id,received_revision_key,
          accepted_revision_key,source_created_at,display_name,column_key,reason,issues,published_revision)
        SELECT 'packet',id::text,'1','1','2026-09-20T00:00:00Z'::timestamptz,'E2E hidden','parsed','awaiting_cut',
          '{}'::text[],(SELECT published_revision FROM mdf_engine_state) FROM unnest($1::uuid[]) id`, [hiddenIds]);
    } finally { await fixture.client.query('SET session_replication_role=origin'); }
    const o = await makeOrder();
    const visibleId = await packet(o, { workday: '2026-09-25' });
    const belowLimit = await read({ dateTo, displayFrom });
    expect(belowLimit.cards.some(c => c.id === visibleId)).toBe(true);
    expect(hiddenIds.some(id => belowLimit.cards.some(c => c.id === id))).toBe(false);
    expect(belowLimit.cards.length).toBeLessThan(1001);

    // Now make >1000 of those same raw rows pass the display cut too (recent workday): the limit fires again,
    // proving the 422 is about the count of DISPLAYED rows, not raw candidates.
    await fixture.client.query('UPDATE cnc_telegram_packets SET workday=$2::date WHERE packet_id=ANY($1::uuid[])',
      [hiddenIds, '2026-09-25']);
    await expect(read({ dateTo, displayFrom })).rejects.toMatchObject({ code: 'MDF_PUBLICATION_SCOPE_LIMIT' });
  });
});

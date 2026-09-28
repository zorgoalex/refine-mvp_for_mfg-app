import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { CurrentUser } from '../../../permissions/current-user';
import { ROLE_POLICIES } from '../../../permissions/policies/role-policies';
import { createMdfCorrectionPgFixture } from './mdf-correction-test-fixture.integration';
import { recordMdfReceipt, type MdfReceiptInput } from '../application/mdf-receipt';
import { MdfJobRunner } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { readMdfPublishedSnapshot } from './mdf-published-snapshot';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';
const admin: CurrentUser = { id: '1', username: 'E2E presentation', role: 'admin', roleId: 1,
  permissions: ['orders.view', 'cut.view', 'cut.manage'] };

/** §5.6 published reader: presentation bound to the accepted revision, source-specific progress, search by order,
 * unregistered sources, authorization/redaction, read-only. */
describe.skipIf(!enabled)('MDF published presentation, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e_mdf_presentation');
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
      INSERT INTO users(user_id,username,role_id,is_active) VALUES (1,'E2E presentation',1,true),(2,'E2E scoped',1,true);
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
    throw new Error('E2E_PRESENTATION_QUEUE_NOT_DRAINED');
  }

  async function makeOrder(createdBy = 1, quantity = 10) {
    const orderId = ++sequence;
    await fixture.client.query(`INSERT INTO orders(order_id,order_name,order_kind,delete_flag,version,order_status_id,
      payment_status_id,created_by) VALUES($1,$2,'production_order',false,1,1,1,$3)`, [orderId, `E2E-П ${orderId}`, createdBy]);
    const detailId = orderId * 100 + 1;
    await fixture.client.query(`INSERT INTO order_details(detail_id,order_id,detail_number,quantity,production_status_id,
      delete_flag,material_id) VALUES($1,$2,1,$3,1,false,1)`, [detailId, orderId, quantity]);
    return { orderId, detailId };
  }

  /** Raw packet (items for the given positions) + a composition-establishing receipt (binding computed) + job.
   * §5.8: `workday` is the legacy display date for the default card set — it defaults to the source day (`createdAt`)
   * so cards register within the shared `read()` default window; pass `workday` to test the display cut itself. */
  async function packet(positions: { orderId: number; detailId: number; quantity: number; cut?: number }[],
    options: { createdAt?: string; workday?: string; register?: boolean } = {}) {
    const packetId = randomUUID();
    const createdAt = options.createdAt ?? '2026-09-20T10:00:00Z';
    const workday = options.workday ?? createdAt.slice(0, 10);
    await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,
      source_version,payload_hash,workday,completion_status,thumbs_up,completed_at,material_name,program_name,mdf_board_card_kind,
      created_at,updated_at,source_created_at,parse_status,rework,mdf_completion_returned,comments_json)
      VALUES($1,$2,'E2E','1',1,$3,$5::date,'pending',false,NULL,'МДФ фасад 10 мм','CNC#_E2E.nc','machine_file',
        now(),now(),$4,'parsed',false,false,'["первый комментарий"]'::jsonb)`,
    [packetId, `E2E-${packetId.slice(0, 8)}`, createHash('sha256').update(packetId).digest('hex'), createdAt, workday]);
    for (const [index, p] of positions.entries()) {
      await fixture.client.query(`INSERT INTO cnc_telegram_packet_items(packet_item_id,packet_id,source_item_key,match_order_id,
        match_detail_id,match_status,quantity,order_name,detail_number,width_mm,height_mm,source)
        VALUES($1,$2,$3,$4,$5,'matched',$6,'E2E',1,300,500,'manual')`,
      [randomUUID(), packetId, `part-${index + 1}`, p.orderId, p.detailId, p.quantity]);
    }
    if (options.register === false) return { packetId };
    const demand = (await fixture.client.query<{ orderId: number; detailId: number; quantity: number }>(`SELECT
      order_id::int "orderId",detail_id::int "detailId",quantity::int quantity FROM order_details
      WHERE order_id=ANY($1::bigint[]) AND NOT delete_flag ORDER BY 1,2`, [[...new Set(positions.map(p => p.orderId))]])).rows;
    const input: MdfReceiptInput = { sourceKind: 'packet', sourceId: packetId, revisionKey: 'r1', origin: 'cnc',
      actorUserId: 1, requestId: `E2E presentation ${packetId}`, causeKey: `E2E presentation ${packetId}`, expectedFence: null,
      accept: true, rules: [], presentation: 'compute',
      executionContext: { sourceCreatedAt: createdAt, displayName: `E2E packet ${packetId.slice(0, 8)}`, priorColumn: 'parsed',
        compositionComplete: true, demand },
      lines: positions.flatMap((p, i) => [
        { lineKey: `m${i}`, orderId: p.orderId, detailId: p.detailId, quantity: p.quantity, stageCode: 'membership',
          evidenceKind: 'derived' as const, rework: false },
        ...(p.cut ? [{ lineKey: `c${i}`, orderId: p.orderId, detailId: p.detailId, quantity: p.cut, stageCode: 'cut',
          evidenceKind: 'physical' as const, rework: false }] : [])]) };
    await db().transaction(tx => recordMdfReceipt(tx, input));
    await drain();
    return { packetId };
  }

  // §5.8: displayFrom defaults to dateTo-6 (2026-09-21), which would cut out most of this file's fixed 2026-09-20
  // fixtures; widen it here so existing presentation/progress/redaction assertions keep testing what they name, not
  // the display cut. Dedicated display-cut coverage lives in mdf-published-snapshot.display-cut.integration.test.ts.
  const read = (user: CurrentUser = admin, query = {}) => readMdfPublishedSnapshot(db(), user,
    { dateTo: '2026-09-27', displayFrom: '2026-09-01', ...query });
  const presentationOf = (snapshot: Awaited<ReturnType<typeof read>>, id: string) => snapshot.presentation.find(p => p.id === id)!;

  it('binds presentation to the accepted revision: items/names shown, raw size/image change ⇒ stale, comment change ⇒ not stale', async () => {
    const o = await makeOrder();
    const { packetId } = await packet([{ ...o, quantity: 10, cut: 10 }]);
    const first = await read();
    expect(presentationOf(first, packetId)).toMatchObject({ stale: false,
      composition: { items: [{ orderId: o.orderId, detailId: o.detailId, widthMm: 300, heightMm: 500, quantity: 10 }],
        programName: 'CNC#_E2E.nc', materialName: 'МДФ фасад 10 мм' },
      live: { comments: ['первый комментарий'], rework: false } });
    expect(first.orders).toEqual(expect.arrayContaining([{ orderId: o.orderId, orderName: `E2E-П ${o.orderId}` }]));
    // Live annotation: current value, never stale.
    await fixture.client.query(`UPDATE cnc_telegram_packets SET comments_json='["переделка CNC#_E2E.nc"]'::jsonb,rework=true
      WHERE packet_id=$1`, [packetId]);
    const commented = presentationOf(await read(), packetId);
    expect(commented).toMatchObject({ stale: false, live: { comments: ['переделка CNC#_E2E.nc'], rework: true } });
    // Same members, changed dimensions ⇒ stale (minimal card).
    await fixture.client.query('UPDATE cnc_telegram_packet_items SET width_mm=301 WHERE packet_id=$1', [packetId]);
    expect(presentationOf(await read(), packetId)).toMatchObject({ stale: true, composition: null });
    await fixture.client.query('UPDATE cnc_telegram_packet_items SET width_mm=300 WHERE packet_id=$1', [packetId]);
    expect(presentationOf(await read(), packetId).stale).toBe(false);
    await fixture.client.query("UPDATE cnc_telegram_packets SET sheet_image_storage_key='e2e/new.png' WHERE packet_id=$1", [packetId]);
    expect(presentationOf(await read(), packetId).stale).toBe(true);
  });

  it('a carrying receipt inherits the binding and never refreshes a stale one', async () => {
    const o = await makeOrder();
    const { packetId } = await packet([{ ...o, quantity: 10 }]);
    await fixture.client.query('UPDATE cnc_telegram_packet_items SET height_mm=499 WHERE packet_id=$1', [packetId]);
    // An observation-like carrying receipt (no presentation flag) on the changed raw data.
    const head = (await fixture.client.query<{ version: string; epoch: string }>(`SELECT version::text,correction_epoch::text epoch
      FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`, [packetId])).rows[0];
    await db().transaction(tx => recordMdfReceipt(tx, { sourceKind: 'packet', sourceId: packetId, revisionKey: 'r2', origin: 'cnc',
      actorUserId: 1, requestId: 'E2E carry', causeKey: 'E2E carry', expectedFence: { version: head.version, correctionEpoch: head.epoch },
      accept: true, rules: [],
      executionContext: { sourceCreatedAt: '2026-09-20T10:00:00Z', displayName: 'E2E carry', priorColumn: 'parsed',
        compositionComplete: true, demand: [{ orderId: o.orderId, detailId: o.detailId, quantity: 10 }] },
      lines: [{ lineKey: 'm0', orderId: o.orderId, detailId: o.detailId, quantity: 10, stageCode: 'membership',
        evidenceKind: 'derived', rework: false }] }));
    await drain();
    const bindings = (await fixture.client.query<{ revision_key: string; presentation_digest: string }>(`SELECT revision_key,
      presentation_digest FROM mdf_revision_presentation WHERE source_kind='packet' AND source_id=$1 ORDER BY revision_key`,
    [packetId])).rows;
    expect(bindings.map(b => b.revision_key)).toEqual(['r1', 'r2']);
    expect(bindings[1].presentation_digest).toBe(bindings[0].presentation_digest);
    expect(presentationOf(await read(), packetId).stale).toBe(true);
  });

  it('publishes source-specific progress: split packets A 6 (cut) / B 4 (uncut) of one 10-unit position', async () => {
    const o = await makeOrder();
    const a = await packet([{ ...o, quantity: 6, cut: 6 }]);
    const b = await packet([{ ...o, quantity: 4 }]);
    const snapshot = await read();
    expect(snapshot.progress.filter(p => p.id === a.packetId)).toEqual([expect.objectContaining({ member: 6, cut: 6 })]);
    expect(snapshot.progress.filter(p => p.id === b.packetId)).toEqual([expect.objectContaining({ member: 4, cut: 0 })]);
    expect(snapshot.positions.find(p => p.orderId === o.orderId)).toMatchObject({ required: 10, creditedCut: 6, remaining: 4 });
  });

  it('finds an old card by searchOrderIds without focus; orderIds alone adds only positions', async () => {
    const o = await makeOrder();
    const { packetId } = await packet([{ ...o, quantity: 10, cut: 10 }], { createdAt: '2026-03-01T10:00:00Z' });
    expect((await read()).cards.some(c => c.id === packetId)).toBe(false);
    expect((await read(admin, { orderIds: [o.orderId] })).cards.some(c => c.id === packetId)).toBe(false);
    expect((await read(admin, { searchOrderIds: [o.orderId] })).cards.some(c => c.id === packetId)).toBe(true);
  });

  it('redacts: a scoped user sees only visible items, no program/comments of a mixed card, no hidden unregistered source', async () => {
    const mine = await makeOrder(2), foreign = await makeOrder(1);
    const { packetId } = await packet([{ ...mine, quantity: 10 }, { ...foreign, quantity: 10 }]);
    const unregisteredMine = await packet([{ ...mine, quantity: 10 }], { register: false });
    const unregisteredMixed = await packet([{ ...mine, quantity: 10 }, { ...foreign, quantity: 10 }], { register: false });
    const scoped: CurrentUser = { ...admin, id: '2', policyScopes: { ...ROLE_POLICIES.admin,
      orders: { view: 'own', update: 'own', export: 'own', delete: 'own' } } } as CurrentUser;
    const view = await read(scoped);
    const card = view.cards.find(c => c.id === packetId)!;
    expect(card.issues).toContain('MDF_PARTIAL_ACCESS');
    const p = presentationOf(view, packetId);
    expect(p.composition?.items.map(i => i.orderId)).toEqual([mine.orderId]);
    expect(p.composition).not.toHaveProperty('programName');
    expect(p.live).toBeNull();
    expect(view.orders.map(x => x.orderId)).not.toContain(foreign.orderId);
    expect(view.progress.some(x => x.orderId === foreign.orderId)).toBe(false);
    expect(view.unregistered.map(u => u.id)).toContain(unregisteredMine.packetId);
    expect(view.unregistered.map(u => u.id)).not.toContain(unregisteredMixed.packetId);
    expect((await read()).unregistered.map(u => u.id)).toEqual(expect.arrayContaining([unregisteredMine.packetId, unregisteredMixed.packetId]));
  });

  it('reading changes nothing and runs no automation', async () => {
    const o = await makeOrder();
    await packet([{ ...o, quantity: 10, cut: 10 }]);
    const tables = ['mdf_source_heads', 'mdf_evidence_revisions', 'mdf_evidence_lines', 'mdf_recalculation_jobs',
      'mdf_bath_allocations', 'mdf_published_sources', 'mdf_published_positions', 'mdf_revision_presentation', 'audit_log',
      'outbox_events', 'orders', 'order_details', 'mdf_engine_state'];
    const before = await fixture.snapshot(tables);
    for (let i = 0; i < 3; i += 1) {
      await read();
      await read(admin, { searchOrderIds: [o.orderId] });
    }
    expect(await fixture.snapshot(tables)).toEqual(before);
  });

  it('neutral name for a partial viewer (source names can identify hidden co-owners)', async () => {
    const mine = await makeOrder(2), foreign = await makeOrder(1);
    const { packetId } = await packet([{ ...mine, quantity: 10 }, { ...foreign, quantity: 10 }]);
    const scoped: CurrentUser = { ...admin, id: '2', policyScopes: { ...ROLE_POLICIES.admin,
      orders: { view: 'own', update: 'own', export: 'own', delete: 'own' } } } as CurrentUser;
    expect((await read(scoped)).cards.find(c => c.id === packetId)!.displayName).toBe(`Файл станка ${packetId}`);
    expect((await read()).cards.find(c => c.id === packetId)!.displayName).toContain('E2E packet');
  });

  it('card progress uses stage coverage: overlapping physical 10 + declaration 10 counts 10', async () => {
    const o = await makeOrder();
    const packetId = randomUUID();
    await fixture.client.query(`INSERT INTO cnc_telegram_packets(packet_id,external_packet_key,source_chat_id,source_message_id,
      source_version,payload_hash,workday,completion_status,thumbs_up,material_name,program_name,mdf_board_card_kind,
      created_at,updated_at,source_created_at,parse_status,rework,mdf_completion_returned)
      VALUES($1,$2,'E2E','1',1,$3,'2026-09-20'::date,'pending',false,'МДФ фасад 10 мм','CNC#_OVERLAP.nc','machine_file',
        now(),now(),'2026-09-20T10:00:00Z','parsed',false,false)`, [packetId, `E2E-ov-${packetId.slice(0, 6)}`, 'd'.repeat(64)]);
    await db().transaction(tx => recordMdfReceipt(tx, { sourceKind: 'packet', sourceId: packetId, revisionKey: 'r1', origin: 'cnc',
      actorUserId: 1, requestId: 'E2E overlap', causeKey: 'E2E overlap', expectedFence: null, accept: true, rules: [],
      executionContext: { sourceCreatedAt: '2026-09-20T10:00:00Z', displayName: 'E2E overlap', priorColumn: 'parsed',
        compositionComplete: true, demand: [{ orderId: o.orderId, detailId: o.detailId, quantity: 10 }] },
      lines: [
        { lineKey: 'm', orderId: o.orderId, detailId: o.detailId, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'p', orderId: o.orderId, detailId: o.detailId, quantity: 10, stageCode: 'cut', evidenceKind: 'physical', rework: false },
        { lineKey: 'd', orderId: o.orderId, detailId: o.detailId, quantity: 10, stageCode: 'cut', evidenceKind: 'declaration', rework: false },
      ] }));
    await drain();
    expect((await read()).progress.filter(p => p.id === packetId)).toEqual([expect.objectContaining({ member: 10, cut: 10 })]);
  });

  it('BASIS presentation lists only rows that establish MDF membership', async () => {
    const o = await makeOrder();
    const setId = 900000 + sequence;
    await fixture.client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,version,created_at,updated_at)
      VALUES($1,'E2E набор',1,'2026-09-20','2026-09-20')`, [setId]);
    await fixture.client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,sort_order,source_type,
      source_order_id,source_order_detail_id,cut_enabled,material_name,position,cut_length_mm,cut_width_mm,quantity,created_at,updated_at)
      VALUES($1,$2,1,'order_detail',$3,$4,true,'МДФ фасад 10 мм','1',600,400,10,now(),now()),
            ($5,$2,2,'order_detail',$3,$4,false,'МДФ фасад 10 мм','2',100,100,3,now(),now()),
            ($6,$2,3,'order_detail',$3,$4,true,'ХДФ 3 мм','3',100,100,2,now(),now())`,
    [setId * 10 + 1, setId, o.orderId, o.detailId, setId * 10 + 2, setId * 10 + 3]);
    await db().transaction(tx => recordMdfReceipt(tx, { sourceKind: 'bazisCutSet', sourceId: String(setId), revisionKey: 'r1',
      origin: 'derived', presentation: 'compute', actorUserId: 1, requestId: 'E2E basis', causeKey: 'E2E basis', expectedFence: null,
      accept: true, rules: [],
      executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z', displayName: 'E2E набор', priorColumn: 'parsed',
        compositionComplete: true, demand: [{ orderId: o.orderId, detailId: o.detailId, quantity: 10 }] },
      lines: [{ lineKey: String(setId * 10 + 1), orderId: o.orderId, detailId: o.detailId, quantity: 10, stageCode: 'membership',
        evidenceKind: 'derived', rework: false }] }));
    await drain();
    const p = presentationOf(await read(), String(setId));
    expect(p).toMatchObject({ stale: false, composition: { items: [expect.objectContaining({ widthMm: 600, heightMm: 400, quantity: 10 })] } });
    expect(p.composition!.items).toHaveLength(1);
  });

  it('a detached position disappears from items; until republished the card is stale', async () => {
    const a = await makeOrder(), b = await makeOrder();
    const { packetId } = await packet([{ ...a, quantity: 10 }, { ...b, quantity: 10 }]);
    await fixture.client.query(`INSERT INTO mdf_position_detachments(source_kind,source_id,order_id,detail_id,correction_id,
      request_id,actor_user_id) VALUES('packet',$1,$2,$3,gen_random_uuid(),'e2e-detached-presentation',1)`, [packetId, b.orderId, b.detailId]);
    // Published members still contain B until the next job republishes ⇒ membership mismatch ⇒ stale.
    expect(presentationOf(await read(), packetId).stale).toBe(true);
    const head = (await fixture.client.query<{ version: string; epoch: string }>(`SELECT version::text,correction_epoch::text epoch
      FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`, [packetId])).rows[0];
    await db().transaction(tx => recordMdfReceipt(tx, { sourceKind: 'packet', sourceId: packetId, revisionKey: 'r2', origin: 'cnc',
      actorUserId: 1, requestId: 'E2E detached refresh', causeKey: 'E2E detached refresh',
      expectedFence: { version: head.version, correctionEpoch: head.epoch }, accept: true, rules: [],
      executionContext: { sourceCreatedAt: '2026-09-20T10:00:00Z', displayName: 'E2E refresh', priorColumn: 'parsed',
        compositionComplete: true, demand: [{ orderId: a.orderId, detailId: a.detailId, quantity: 10 }] },
      lines: [
        { lineKey: 'm0', orderId: a.orderId, detailId: a.detailId, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'm1', orderId: b.orderId, detailId: b.detailId, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
      ] }));
    await drain();
    const p = presentationOf(await read(), packetId);
    expect(p.stale).toBe(false);
    expect(p.composition!.items.map(i => i.orderId)).toEqual([a.orderId]);
  });

  it('keeps a published card\'s progress after a detachment until the successor revision is published (D1)', async () => {
    const a = await makeOrder(), b = await makeOrder();
    const { packetId } = await packet([{ ...a, quantity: 10, cut: 10 }, { ...b, quantity: 10, cut: 10 }]);
    const before = await read();
    const progressOf = (snap: Awaited<ReturnType<typeof read>>) => snap.progress.filter((p) => p.id === packetId);
    expect(progressOf(before)).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderId: a.orderId, detailId: a.detailId, member: 10, cut: 10 }),
      expect.objectContaining({ orderId: b.orderId, detailId: b.detailId, member: 10, cut: 10 }),
    ]));
    // A correction commits B's detachment (recorded now), but the publication job for the successor
    // revision has NOT run yet — GET between correction commit and job publication.
    await fixture.client.query(`INSERT INTO mdf_position_detachments(source_kind,source_id,order_id,detail_id,correction_id,
      request_id,actor_user_id) VALUES('packet',$1,$2,$3,gen_random_uuid(),'e2e-progress-detached',1)`,
    [packetId, b.orderId, b.detailId]);
    const between = await read();
    // The still-published revision's progress is unchanged: no logical mismatch (cut 0/10 next to credited 10/10).
    expect(progressOf(between)).toEqual(progressOf(before));
    // Once the successor revision publishes (the detachment predates it), progress finally drops B.
    const head = (await fixture.client.query<{ version: string; epoch: string }>(`SELECT version::text,correction_epoch::text epoch
      FROM mdf_source_heads WHERE source_kind='packet' AND source_id=$1`, [packetId])).rows[0];
    await db().transaction((tx) => recordMdfReceipt(tx, { sourceKind: 'packet', sourceId: packetId, revisionKey: 'r2', origin: 'cnc',
      actorUserId: 1, requestId: 'E2E progress refresh', causeKey: 'E2E progress refresh',
      expectedFence: { version: head.version, correctionEpoch: head.epoch }, accept: true, rules: [],
      executionContext: { sourceCreatedAt: '2026-09-20T10:00:00Z', displayName: 'E2E progress refresh', priorColumn: 'parsed',
        compositionComplete: true, demand: [{ orderId: a.orderId, detailId: a.detailId, quantity: 10 }] },
      lines: [
        { lineKey: 'm0', orderId: a.orderId, detailId: a.detailId, quantity: 10, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'c0', orderId: a.orderId, detailId: a.detailId, quantity: 10, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ] }));
    await drain();
    const after = await read();
    expect(progressOf(after).map((p) => p.detailId)).toEqual([a.detailId]);
  });

  it('unregistered lane uses the shared MDF classifier (a non-MDF marker in the file name excludes the packet)', async () => {
    const o = await makeOrder();
    const hdf = await packet([{ ...o, quantity: 10 }], { register: false });
    await fixture.client.query("UPDATE cnc_telegram_packets SET program_name='CNC#_ХДФ_3мм.nc' WHERE packet_id=$1", [hdf.packetId]);
    const mdf = await packet([{ ...o, quantity: 10 }], { register: false });
    const lane = (await read()).unregistered.map(u => u.id);
    expect(lane).toContain(mdf.packetId);
    expect(lane).not.toContain(hdf.packetId);
  });

  it('source-wide names need every raw-content owner visible (non-MDF rows of a hidden order count)', async () => {
    const mine = await makeOrder(2), foreign = await makeOrder(1);
    const setId = 910000 + sequence;
    await fixture.client.query(`INSERT INTO bazis_cut_sets(bazis_cut_set_id,name,version,created_at,updated_at)
      VALUES($1,'Набор клиента Иванова',1,'2026-09-20','2026-09-20')`, [setId]);
    await fixture.client.query(`INSERT INTO bazis_cut_set_details(bazis_cut_set_detail_id,bazis_cut_set_id,sort_order,source_type,
      source_order_id,source_order_detail_id,cut_enabled,material_name,position,cut_length_mm,cut_width_mm,quantity,created_at,updated_at)
      VALUES($1,$2,1,'order_detail',$3,$4,true,'МДФ фасад 10 мм','1',600,400,10,now(),now()),
            ($5,$2,2,'order_detail',$6,$7,true,'ЛДСП 16 мм','2',100,100,3,now(),now())`,
    [setId * 10 + 1, setId, mine.orderId, mine.detailId, setId * 10 + 2, foreign.orderId, foreign.detailId]);
    await db().transaction(tx => recordMdfReceipt(tx, { sourceKind: 'bazisCutSet', sourceId: String(setId), revisionKey: 'r1',
      origin: 'derived', presentation: 'compute', actorUserId: 1, requestId: 'E2E mixed set', causeKey: 'E2E mixed set',
      expectedFence: null, accept: true, rules: [],
      executionContext: { sourceCreatedAt: '2026-09-20T00:00:00Z', displayName: 'Набор клиента Иванова', priorColumn: 'parsed',
        compositionComplete: true, demand: [{ orderId: mine.orderId, detailId: mine.detailId, quantity: 10 }] },
      lines: [{ lineKey: String(setId * 10 + 1), orderId: mine.orderId, detailId: mine.detailId, quantity: 10,
        stageCode: 'membership', evidenceKind: 'derived', rework: false }] }));
    await drain();
    const scoped: CurrentUser = { ...admin, id: '2', policyScopes: { ...ROLE_POLICIES.admin,
      orders: { view: 'own', update: 'own', export: 'own', delete: 'own' } } } as CurrentUser;
    const view = await read(scoped);
    const card = view.cards.find(c => c.id === String(setId))!;
    // The MDF owner is visible (no partial access on accounting), but the set name stays hidden.
    expect(card.issues).not.toContain('MDF_PARTIAL_ACCESS');
    expect(card.displayName).toBe(`Набор БАЗИС ${setId}`);
    expect(presentationOf(view, String(setId)).live).toBeNull();
    expect((await read()).cards.find(c => c.id === String(setId))!.displayName).toBe('Набор клиента Иванова');
  });
});

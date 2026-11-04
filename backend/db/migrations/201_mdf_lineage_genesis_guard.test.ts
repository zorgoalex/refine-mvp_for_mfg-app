import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMdfCorrectionPgFixture } from '../../src/modules/mdf-board/adapters/mdf-correction-test-fixture.integration';
import { recordMdfLineageReceipt, recordMdfReceipt, type MdfReceiptResult } from '../../src/modules/mdf-board/application/mdf-receipt';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

/** §5.8 logic audit (B1): migration 201 relaxes `mdf_guard_physical_lineage_source_head()` (migration 182) so a
 * lineage-v2 source may receive a contract-less revision — e.g. a bath retirement receipt (`mdf-bath-lifecycle.ts`'s
 * `recordMdfBathTransition`, plain `lines: []`) or any other genesis/membership-only revision — as long as that
 * revision carries NO physical evidence line. A contract-less revision that DOES carry a physical line is still
 * refused exactly as before 201. Design: spec_erp/reviews/mdf-engine-logic-audit-20260928 (B1 follow-up). */
describe.skipIf(!enabled)('MDF lineage genesis guard migration 201, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e201genesis');
  let database: ReturnType<typeof fixture.createDatabaseService>;

  beforeAll(async () => {
    await fixture.connect();
    database = fixture.createDatabaseService();
    await fixture.clonePublicTables([
      'orders', 'order_details', 'order_statuses', 'production_statuses', 'materials', 'sheet_material_types',
      'users', 'status_automation_rules', 'outbox_events', 'audit_log', 'audit_log_related_entity', 'app_settings',
      'order_workshops', 'bazis_order_links', 'order_import_entity_map', 'bazis_cut_sets', 'bazis_cut_set_details',
      'cnc_telegram_packets', 'cnc_telegram_packet_items', 'cnc_telegram_packet_whole_order_keys',
      'cut_result', 'cut_result_board_projection', 'cut_result_placement', 'cut_result_sheet_map',
    ]);
    await fixture.client.query('ALTER TABLE cnc_telegram_packets ADD PRIMARY KEY(packet_id)');
    await fixture.applyMigrations([
      '165_mdf_engine_foundation.sql', '166_mdf_engine_fences.sql',
      '174_mdf_execution_context.sql', '175_mdf_command_placement.sql',
      '178_mdf_correction_receipts.sql', '179_mdf_active_return.sql',
      '182_mdf_physical_lineage.sql', '185_mdf_bazis_composition.sql', '187_mdf_bazis_refill_rows.sql',
      '188_mdf_order_cascade_intents.sql', '189_mdf_placement_inputs.sql', '190_mdf_bath_transitions.sql',
      '191_mdf_order_corrections.sql', '192_mdf_board_presentation_history.sql', '195_mdf_baseline_population.sql',
      '201_mdf_lineage_genesis_guard.sql',
    ]);
  }, 30000);

  afterAll(async () => {
    await database.onModuleDestroy();
    await fixture.drop();
  });

  const functionDef = async () => (await fixture.client.query<{ def: string }>(`SELECT pg_get_functiondef(p.oid) def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=$1 AND p.proname='mdf_guard_physical_lineage_source_head'`, [fixture.schema])).rows[0].def;
  const md5 = (value: string) => createHash('md5').update(value).digest('hex');

  it('applies idempotently and matches the exact reviewed function definition', async () => {
    const before = await functionDef();
    // Re-applying 201 (CREATE OR REPLACE) must be a no-op, not an error.
    await fixture.applyMigrations(['201_mdf_lineage_genesis_guard.sql']);
    const after = await functionDef();
    expect(after).toBe(before);
    // `pg_get_functiondef` schema-qualifies the CREATE line with THIS fixture's own randomized schema
    // (`createMdfCorrectionPgFixture` appends a fresh UUID per run — see mdf-correction-test-fixture.integration.ts),
    // so a literal hash of the raw text can never be stable across runs/environments. Normalize that prefix to the
    // canonical `public.` schema before hashing (not stripped to nothing — verified against the task's own value):
    // stable across independent random schemas and matches the reviewed public-schema function hash exactly.
    const stripped = after.replace(new RegExp(`^CREATE OR REPLACE FUNCTION ${fixture.schema}\\.`),
      'CREATE OR REPLACE FUNCTION public.');
    expect(md5(stripped)).toBe('4895f75ef2c486bccd3715f8ab8e6dab');
  });

  /** A real, accepted v2-lineage 'production' revision (membership + one physical 'cut' line), via the same
   * `recordMdfLineageReceipt` path the application uses — establishes `mdf_physical_lineage_contracts` for this
   * (source_kind,source_id), i.e. makes it a "v2 source" for the guard's purposes. */
  async function v2Source(sourceId: string): Promise<MdfReceiptResult> {
    const receipt = await database.transaction(tx => recordMdfLineageReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId, revisionKey: 'v2-root', origin: 'manual', actorUserId: 1,
      requestId: `e2e201-root-${sourceId}`, causeKey: `e2e201-root-${sourceId}`, expectedFence: null, accept: true, rules: [],
      lines: [
        { lineKey: 'member', orderId: 1, detailId: 11, quantity: 1, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'physical', orderId: 1, detailId: 11, quantity: 1, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ],
      lineage: { operation: 'production', authority: 'manual_production', actions: [{ lineKey: 'physical', action: 'root' }],
        droppedPredecessorEvidenceLineIds: [] },
      executionContext: { sourceCreatedAt: '2026-09-24T00:00:00Z', displayName: `E2E 201 ${sourceId}`, priorColumn: 'parsed',
        compositionComplete: true, demand: [{ orderId: 1, detailId: 11, quantity: 1 }] },
    }));
    expect(receipt.accepted).toBe(true);
    return receipt;
  }

  it('UPDATE branch: admits a contract-less follow-up with no physical line onto a v2 source', async () => {
    const sourceId = `update-admit-${randomUUID()}`;
    const root = await v2Source(sourceId);
    // Exactly `mdf-bath-lifecycle.ts`'s own retirement-receipt shape (`recordMdfBathTransition`): no lines at all,
    // `accept:false` (a retirement is not a composition — only the transition worker later accepts it). The
    // app layer requires `accept && !compositionComplete` to never coexist, so a genuinely empty, uncommitted
    // revision must stay received-only here, matching production exactly. Must be admitted, not refused.
    const followUp = await database.transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId, revisionKey: 'retire-1', origin: 'manual', actorUserId: 1,
      requestId: `e2e201-followup-${sourceId}`, causeKey: `e2e201-followup-${sourceId}`,
      expectedFence: { version: root.version, correctionEpoch: root.correctionEpoch }, accept: false, rules: [], lines: [],
      executionContext: { sourceCreatedAt: '2026-09-24T00:00:00Z', displayName: 'retired', priorColumn: 'parsed',
        compositionComplete: false, demand: [] },
    }));
    expect(followUp.accepted).toBe(false);
    expect((await fixture.client.query<{ received: string; accepted: string | null }>(`SELECT received_revision_key received,
      accepted_revision_key accepted FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`,
    [sourceId])).rows[0]).toEqual({ received: 'retire-1', accepted: 'v2-root' });
  });

  // fixes-r1 finding 2: the UPDATE branch's physical-line refusal is now source-wide (an EXISTS over ALL of the
  // source's `mdf_physical_lineage_contracts`, not `old_received_is_v2` scoped to the immediately-preceding
  // revision only) — so a v2 source cannot downgrade to physical evidence THROUGH a contract-less intermediate
  // revision either. R1 (v2, physical) → R2 (contract-less, no physical: admitted, same as the test above) →
  // R3 (contract-less, WITH physical): must still be refused, even though R2 (not R1) is now OLD at that point.
  it('UPDATE branch (fixes-r1 #2): still refuses physical evidence on a THIRD revision reached through a contract-less R2', async () => {
    const sourceId = `update-downgrade-${randomUUID()}`;
    const root = await v2Source(sourceId);
    const r2 = await database.transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId, revisionKey: 'r2-contractless', origin: 'manual', actorUserId: 1,
      requestId: `e2e201-downgrade-r2-${sourceId}`, causeKey: `e2e201-downgrade-r2-${sourceId}`,
      expectedFence: { version: root.version, correctionEpoch: root.correctionEpoch }, accept: false, rules: [], lines: [],
      executionContext: { sourceCreatedAt: '2026-09-24T00:00:00Z', displayName: 'r2', priorColumn: 'parsed',
        compositionComplete: false, demand: [] },
    }));
    expect(r2.accepted).toBe(false);
    expect((await fixture.client.query<{ received: string; accepted: string | null }>(`SELECT received_revision_key received,
      accepted_revision_key accepted FROM mdf_source_heads WHERE source_kind='bazisCutSet' AND source_id=$1`,
    [sourceId])).rows[0]).toEqual({ received: 'r2-contractless', accepted: 'v2-root' });
    // R3: OLD is now R2 (contract-less, so `old_received_is_v2` alone would be false) — the source-wide EXISTS
    // still sees R1's contract and refuses R3's physical line.
    await expect(database.transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId, revisionKey: 'r3-physical', origin: 'manual', actorUserId: 1,
      requestId: `e2e201-downgrade-r3-${sourceId}`, causeKey: `e2e201-downgrade-r3-${sourceId}`,
      expectedFence: { version: r2.version, correctionEpoch: r2.correctionEpoch }, accept: true, rules: [],
      lines: [
        { lineKey: 'member3', orderId: 1, detailId: 11, quantity: 1, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'phys3', orderId: 1, detailId: 11, quantity: 1, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ],
      executionContext: { sourceCreatedAt: '2026-09-24T00:00:00Z', displayName: 'r3', priorColumn: 'parsed',
        compositionComplete: true, demand: [{ orderId: 1, detailId: 11, quantity: 1 }] },
    }))).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('MDF lineage-v2 source requires lineage-v2 receipts') });
    // Nothing persisted: the head is still parked on R2, not advanced/corrupted by the rejected R3 attempt.
    expect((await fixture.client.query(`SELECT received_revision_key received FROM mdf_source_heads
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [sourceId])).rows[0].received).toBe('r2-contractless');
  });

  it('UPDATE branch: still refuses a contract-less follow-up that carries a physical line', async () => {
    const sourceId = `update-refuse-${randomUUID()}`;
    const root = await v2Source(sourceId);
    await expect(database.transaction(tx => recordMdfReceipt(tx, {
      sourceKind: 'bazisCutSet', sourceId, revisionKey: 'retire-with-phys', origin: 'manual', actorUserId: 1,
      requestId: `e2e201-refuse-${sourceId}`, causeKey: `e2e201-refuse-${sourceId}`,
      expectedFence: { version: root.version, correctionEpoch: root.correctionEpoch }, accept: true, rules: [],
      lines: [
        { lineKey: 'member2', orderId: 1, detailId: 11, quantity: 1, stageCode: 'membership', evidenceKind: 'derived', rework: false },
        { lineKey: 'phys2', orderId: 1, detailId: 11, quantity: 1, stageCode: 'cut', evidenceKind: 'physical', rework: false },
      ],
      executionContext: { sourceCreatedAt: '2026-09-24T00:00:00Z', displayName: 'still physical', priorColumn: 'parsed',
        compositionComplete: true, demand: [{ orderId: 1, detailId: 11, quantity: 1 }] },
    }))).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('MDF lineage-v2 source requires lineage-v2 receipts') });
    // Nothing persisted: the whole receipt transaction rolled back with the guard.
    expect((await fixture.client.query(`SELECT received_revision_key received FROM mdf_source_heads
      WHERE source_kind='bazisCutSet' AND source_id=$1`, [sourceId])).rows[0].received).toBe('v2-root');
  });

  // The INSERT branch (TG_OP='INSERT') only ever fires for a (source_kind,source_id)'s very first `mdf_source_heads`
  // row. `mdf_source_heads` rows can never be DELETEd (migration 166's `mdf_guard_source_fence`: "MDF source fence
  // cannot be deleted"), so this exact state — a source with an EXISTING `mdf_physical_lineage_contracts` row but
  // NO `mdf_source_heads` row yet — is not reachable through any real receipt flow either (every receipt that can
  // create a contract also writes the head in the same transaction). It is exercised directly via raw SQL, building
  // a fully valid sealed v2-lineage revision (contract + demand + physical line + matching lineage transition) by
  // hand — the same white-box style as migration 188's own trigger tests and 182's own INSERT-path coverage for
  // this exact function — and only then attempting the FIRST-EVER head insert.
  async function sealV2ContractOnly(sourceId: string) {
    const revisionKey = 'contract-rev';
    await fixture.client.query(`INSERT INTO mdf_evidence_revisions
      (source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
      VALUES('bath',$1,$2,$3,'manual',1,$4,$4)`,
    [sourceId, revisionKey, 'a'.repeat(64), `req-contract-${sourceId}`]);
    await fixture.client.query(`INSERT INTO mdf_revision_context
      (source_kind,source_id,revision_key,source_created_at,display_name,prior_column,composition_complete,
        demand_digest,acceptance_requested,predecessor_accepted_revision_key,predecessor_received_revision_key,effect_policy)
      VALUES('bath',$1,$2,'2026-09-24','contract root','parsed',true,$3,true,NULL,NULL,'forward')`,
    [sourceId, revisionKey, 'b'.repeat(64)]);
    await fixture.client.query(`INSERT INTO mdf_revision_demand(source_kind,source_id,revision_key,order_id,detail_id,quantity)
      VALUES('bath',$1,$2,1,11,1)`, [sourceId, revisionKey]);
    await fixture.client.query(`INSERT INTO mdf_physical_lineage_contracts
      (source_kind,source_id,revision_key,operation,production_authority,predecessor_accepted_revision_key,
        manifest_digest,dropped_predecessor_evidence_line_ids)
      VALUES('bath',$1,$2,'production','manual_production',NULL,$3,ARRAY[]::uuid[])`,
    [sourceId, revisionKey, 'c'.repeat(64)]);
    // A 'root' physical proof must be backed by (<=) a membership quantity at the same position in the SAME
    // revision (182's own "uncredited assignment capacity" guard).
    await fixture.client.query(`INSERT INTO mdf_evidence_lines
      (source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework)
      VALUES('bath',$1,$2,'member-root',1,11,1,'membership','derived',false)`, [sourceId, revisionKey]);
    const line = (await fixture.client.query<{ id: string }>(`INSERT INTO mdf_evidence_lines
      (source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework)
      VALUES('bath',$1,$2,'phys-root',1,11,1,'laminated','physical',false) RETURNING evidence_line_id::text id`,
    [sourceId, revisionKey])).rows[0].id;
    await fixture.client.query(`INSERT INTO mdf_physical_lineage_transitions
      (source_kind,source_id,revision_key,evidence_line_id,action,predecessor_evidence_line_id,canonical_origin_evidence_line_id)
      VALUES('bath',$1,$2,$3,'root',NULL,$3)`, [sourceId, revisionKey, line]);
    await fixture.client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key) VALUES('bath',$1,$2)`,
    [sourceId, revisionKey]);
  }

  async function sealedGenesisRevision(sourceId: string, revisionKey: string, opts: { physical: boolean }) {
    await fixture.client.query(`INSERT INTO mdf_evidence_revisions
      (source_kind,source_id,revision_key,payload_digest,origin,actor_user_id,request_id,cause_key)
      VALUES('bath',$1,$2,$3,'manual',1,$4,$4)`,
    [sourceId, revisionKey, 'e'.repeat(64), `req-${sourceId}-${revisionKey}`]);
    await fixture.client.query(`INSERT INTO mdf_revision_context
      (source_kind,source_id,revision_key,source_created_at,display_name,prior_column,composition_complete,demand_digest)
      VALUES('bath',$1,$2,'2026-09-24','genesis','parsed',true,$3)`,
    [sourceId, revisionKey, 'f'.repeat(64)]);
    if (opts.physical) {
      await fixture.client.query(`INSERT INTO mdf_evidence_lines
        (source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework)
        VALUES('bath',$1,$2,'phys',1,11,1,'cut','physical',false)`, [sourceId, revisionKey]);
    } else {
      await fixture.client.query(`INSERT INTO mdf_evidence_lines
        (source_kind,source_id,revision_key,line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework)
        VALUES('bath',$1,$2,'mem',1,11,1,'membership','derived',false)`, [sourceId, revisionKey]);
    }
    await fixture.client.query(`INSERT INTO mdf_revision_seals(source_kind,source_id,revision_key) VALUES('bath',$1,$2)`,
    [sourceId, revisionKey]);
  }

  it('INSERT branch: admits a contract-less genesis head with no physical line', async () => {
    const sourceId = `insert-admit-${randomUUID()}`;
    await fixture.client.query('BEGIN');
    try {
      await sealV2ContractOnly(sourceId);
      await sealedGenesisRevision(sourceId, 'genesis-no-phys', { physical: false });
      await expect(fixture.client.query(`INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key)
        VALUES('bath',$1,'genesis-no-phys',NULL)`, [sourceId])).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await fixture.client.query('ROLLBACK');
    }
  });

  it('INSERT branch: still refuses a contract-less genesis head that carries a physical line', async () => {
    const sourceId = `insert-refuse-${randomUUID()}`;
    await fixture.client.query('BEGIN');
    try {
      await sealV2ContractOnly(sourceId);
      await sealedGenesisRevision(sourceId, 'genesis-phys', { physical: true });
      await expect(fixture.client.query(`INSERT INTO mdf_source_heads(source_kind,source_id,received_revision_key,accepted_revision_key)
        VALUES('bath',$1,'genesis-phys',NULL)`, [sourceId]))
        .rejects.toMatchObject({ code: '23514', message: expect.stringContaining('MDF lineage-v2 source requires lineage-v2 receipts') });
    } finally {
      await fixture.client.query('ROLLBACK');
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMdfCorrectionPgFixture } from '../../src/modules/mdf-board/adapters/mdf-correction-test-fixture.integration';

const enabled = process.env.MDF_ENGINE_INTEGRATION === '1';

// This suite exercises the DB-level objects of migration 192 directly:
// (1) mdf_revision_presentation — an append-only binding of an accepted MDF
//     revision to the digest of its raw composition-sensitive presentation.
// (2) mdf_source_presentation_digest(text,text) — the digest function itself.
// (3) the conditional in-place redefinition of the two migration-141
//     board-history trigger functions (only when mdf_board_history_events,
//     i.e. 141, is already present; otherwise the redefinition is a no-op and
//     192 still applies cleanly).
//
// Minimal local stand-ins for orders/audit_log/cnc_telegram_* are created
// directly (not cloned from public) — the redefined trigger functions and the
// digest function resolve these tables unqualified via search_path, so a
// schema-local table with just the columns each query touches is sufficient
// and keeps this suite independent of the real application schema.
describe.skipIf(!enabled)('MDF board presentation history migration 192, isolated PostgreSQL schema', () => {
  const fixture = createMdfCorrectionPgFixture('e2e192boardpresent');

  const BASE_CHAIN = ['165_mdf_engine_foundation.sql'] as const;
  const DIGEST_A = 'a'.repeat(64);
  const DIGEST_B = 'b'.repeat(64);

  beforeAll(async () => {
    await fixture.connect();
    // No orders/audit_log tables here — this fixture never applies 141, so the
    // conditional board-history redefinition in 192 is a no-op and only the
    // digest function's packet lookup (below) is exercised in this schema.
    await fixture.client.query(`
      CREATE TABLE cnc_telegram_packets(
        packet_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        program_name TEXT,
        external_packet_key TEXT,
        material_name TEXT,
        sheet_image_storage_key TEXT,
        svg_cut_job_id BIGINT,
        svg_cut_result_id BIGINT,
        cut_layout_json JSONB,
        layout_fingerprint TEXT,
        comments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        rework BOOLEAN NOT NULL DEFAULT false
      );
      CREATE TABLE cnc_telegram_packet_items(
        packet_item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        packet_id UUID NOT NULL REFERENCES cnc_telegram_packets(packet_id),
        source_item_key TEXT NOT NULL,
        match_order_id BIGINT,
        match_detail_id BIGINT,
        detail_number INT,
        width_mm NUMERIC,
        height_mm NUMERIC,
        quantity INT NOT NULL DEFAULT 1
      );`);
    await fixture.applyMigrations([...BASE_CHAIN, '192_mdf_board_presentation_history.sql']);
  }, 30000);

  afterAll(async () => fixture.drop());

  it('requires migration 165 (mdf_evidence_revisions) to be present before it can apply', async () => {
    const bare = createMdfCorrectionPgFixture('e2e192nom165');
    await bare.connect();
    try {
      await expect(bare.applyMigrations(['192_mdf_board_presentation_history.sql']))
        .rejects.toMatchObject({ message: expect.stringContaining('requires migration 165') });
    } finally {
      await bare.drop();
    }
  });

  it('applies idempotently and installs the table, immutable trigger and digest function', async () => {
    await fixture.applyMigrations(['192_mdf_board_presentation_history.sql']);
    await fixture.assertLocalRelations(['mdf_revision_presentation']);

    const triggers = await fixture.client.query<{ tgname: string; tgenabled: string; function_name: string;
      tgtype: number }>(`
      SELECT t.tgname,t.tgenabled,p.proname AS function_name,t.tgtype::int
      FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname=$1 AND r.relname='mdf_revision_presentation' AND NOT t.tgisinternal ORDER BY t.tgname`,
    [fixture.schema]);
    expect(triggers.rows).toEqual([
      { tgname: 'mdf_revision_presentation_immutable', tgenabled: 'O',
        function_name: 'mdf_reject_revision_presentation_change', tgtype: 27 },
    ]);

    const digestFn = await fixture.client.query<{ proname: string }>(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND p.proname='mdf_source_presentation_digest'`, [fixture.schema]);
    expect(digestFn.rows.map((row) => row.proname)).toEqual(['mdf_source_presentation_digest']);
  });

  it('rejects UPDATE and DELETE on a presentation binding row as immutable', async () => {
    await fixture.client.query('BEGIN');
    try {
      await fixture.client.query(`
        INSERT INTO mdf_evidence_revisions(source_kind,source_id,revision_key,payload_digest,origin,request_id,cause_key)
        VALUES ('packet','pkt-immutable','rev-1',$1,'cnc','req-immutable','cause-immutable')`, [DIGEST_A]);
      await expect(fixture.client.query(`
        INSERT INTO mdf_revision_presentation(source_kind,source_id,revision_key,presentation_digest)
        VALUES ('packet','pkt-immutable','rev-1',$1)`, [DIGEST_B])).resolves.toMatchObject({ rowCount: 1 });

      await fixture.client.query('SAVEPOINT before_update');
      await expect(fixture.client.query(
        `UPDATE mdf_revision_presentation SET presentation_digest=$1 WHERE source_id='pkt-immutable'`, [DIGEST_A],
      )).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('immutable') });
      await fixture.client.query('ROLLBACK TO SAVEPOINT before_update');

      await fixture.client.query('SAVEPOINT before_delete');
      await expect(fixture.client.query(
        `DELETE FROM mdf_revision_presentation WHERE source_id='pkt-immutable'`,
      )).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('immutable') });
      await fixture.client.query('ROLLBACK TO SAVEPOINT before_delete');
    } finally {
      await fixture.client.query('ROLLBACK');
    }
  });

  it('enforces the FK to mdf_evidence_revisions', async () => {
    await fixture.client.query('BEGIN');
    try {
      await expect(fixture.client.query(`
        INSERT INTO mdf_revision_presentation(source_kind,source_id,revision_key,presentation_digest)
        VALUES ('packet','pkt-orphan','rev-does-not-exist',$1)`, [DIGEST_A]))
        .rejects.toMatchObject({ code: '23503' });
    } finally {
      await fixture.client.query('ROLLBACK');
    }
  });

  it('mdf_source_presentation_digest returns NULL for unknown or absent sources', async () => {
    const unknownKind = await fixture.client.query<{ digest: string | null }>(
      `SELECT ${fixture.schema}.mdf_source_presentation_digest('unknown-kind','anything') AS digest`);
    expect(unknownKind.rows[0]?.digest).toBeNull();

    const absentPacket = await fixture.client.query<{ digest: string | null }>(
      `SELECT ${fixture.schema}.mdf_source_presentation_digest('packet','00000000-0000-0000-0000-000000000000') AS digest`);
    expect(absentPacket.rows[0]?.digest).toBeNull();

    const malformedId = await fixture.client.query<{ digest: string | null }>(
      `SELECT ${fixture.schema}.mdf_source_presentation_digest('packet','not-a-uuid') AS digest`);
    expect(malformedId.rows[0]?.digest).toBeNull();
  });

  it('computes a stable packet digest sensitive to item geometry but not to annotations', async () => {
    const packet = await fixture.client.query<{ packet_id: string }>(`
      INSERT INTO cnc_telegram_packets(external_packet_key,material_name,program_name,comments_json,rework)
      VALUES ('EPK-digest','МДФ 16мм','prog-1','[]'::jsonb,false) RETURNING packet_id`);
    const packetId = packet.rows[0]!.packet_id;
    const item = await fixture.client.query<{ packet_item_id: string }>(`
      INSERT INTO cnc_telegram_packet_items(packet_id,source_item_key,width_mm,height_mm,quantity)
      VALUES ($1,'item-1',600,400,2) RETURNING packet_item_id`, [packetId]);
    const itemId = item.rows[0]!.packet_item_id;

    const digest = (id: string) => fixture.client.query<{ digest: string | null }>(
      `SELECT ${fixture.schema}.mdf_source_presentation_digest('packet',$1) AS digest`, [id])
      .then((res) => res.rows[0]?.digest ?? null);

    const first = await digest(packetId);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    const second = await digest(packetId);
    expect(second).toBe(first);

    await fixture.client.query(
      `UPDATE cnc_telegram_packet_items SET width_mm=601 WHERE packet_item_id=$1`, [itemId]);
    const afterWidthChange = await digest(packetId);
    expect(afterWidthChange).not.toBe(first);

    await fixture.client.query(
      `UPDATE cnc_telegram_packet_items SET width_mm=600 WHERE packet_item_id=$1`, [itemId]);
    const restoredWidth = await digest(packetId);
    expect(restoredWidth).toBe(first);

    await fixture.client.query(
      `UPDATE cnc_telegram_packets SET comments_json=$1::jsonb, rework=true WHERE packet_id=$2`,
      [JSON.stringify([{ text: 'unrelated annotation' }]), packetId]);
    const afterAnnotationChange = await digest(packetId);
    expect(afterAnnotationChange).toBe(first);
  });

  it('applies without migration 141 present, skipping the history redefinition', async () => {
    const tableExists = await fixture.client.query<{ present: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS present`, [`${fixture.schema}.mdf_board_history_events`]);
    expect(tableExists.rows[0]?.present).toBe(false);

    const functionsExist = await fixture.client.query<{ proname: string }>(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND p.proname IN
        ('record_mdf_board_history_from_audit','record_mdf_board_history_from_audit_relation')`,
    [fixture.schema]);
    expect(functionsExist.rows).toEqual([]);

    // 192's own objects are unaffected by the absence of 141.
    const digestNull = await fixture.client.query<{ digest: string | null }>(
      `SELECT ${fixture.schema}.mdf_source_presentation_digest('unknown','x') AS digest`);
    expect(digestNull.rows[0]?.digest).toBeNull();
  });

  describe('with migration 141 (mdf_board_history) applied', () => {
    const withHistory = createMdfCorrectionPgFixture('e2e192withhistory');

    beforeAll(async () => {
      await withHistory.connect();
      await withHistory.client.query(`
        CREATE TABLE users(user_id BIGINT PRIMARY KEY);
        CREATE TABLE orders(order_id BIGINT PRIMARY KEY);
        CREATE TABLE audit_log(
          audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          event TEXT NOT NULL,
          entity_type TEXT,
          entity_id TEXT,
          user_id BIGINT,
          request_id TEXT NOT NULL DEFAULT '',
          before_json JSONB,
          after_json JSONB,
          diff_json JSONB,
          metadata_json JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          related_order_id BIGINT,
          status_name TEXT,
          status_code TEXT
        );
        CREATE TABLE audit_log_related_entity(
          audit_id UUID NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id BIGINT NOT NULL
        );`);
      await withHistory.applyMigrations([
        ...BASE_CHAIN, '141_mdf_board_history.sql', '192_mdf_board_presentation_history.sql',
      ]);
    }, 30000);

    afterAll(async () => withHistory.drop());

    let orderSeq = 90000;
    const nextOrder = async () => {
      const orderId = orderSeq++;
      await withHistory.client.query('INSERT INTO orders(order_id) VALUES($1)', [orderId]);
      return orderId;
    };

    it('redefines both board-history functions in place (post-192 body present)', async () => {
      for (const fn of ['record_mdf_board_history_from_audit()', 'record_mdf_board_history_from_audit_relation()']) {
        const def = await withHistory.client.query<{ def: string }>(
          `SELECT pg_get_functiondef(oid) AS def FROM pg_proc WHERE oid=to_regprocedure($1)`,
          [`${withHistory.schema}.${fn}`]);
        expect(def.rows).toHaveLength(1);
        expect(def.rows[0]?.def).toContain('mdf_source');
        expect(def.rows[0]?.def).toContain('mdf_bath');
      }
    });

    it("resolves an mdf_source entity 'bath:cut-result:5' to subject bath/cut-result:5 and admits mdf.order_correction.requested", async () => {
      const orderId = await nextOrder();
      const audit = await withHistory.client.query<{ audit_id: string }>(`
        INSERT INTO audit_log(event,entity_type,entity_id,related_order_id)
        VALUES ('mdf.order_correction.requested','mdf_source','bath:cut-result:5',$1) RETURNING audit_id`,
      [orderId]);
      const auditId = audit.rows[0]!.audit_id;

      const events = await withHistory.client.query<{ subject_kind: string; subject_id: string; order_id: string }>(`
        SELECT subject_kind,subject_id,order_id::text FROM mdf_board_history_events
        WHERE event_key='audit:' || $1 || ':order:' || $2::text`, [auditId, orderId]);
      expect(events.rows).toEqual([{ subject_kind: 'bath', subject_id: 'cut-result:5', order_id: String(orderId) }]);
    });

    it('filters out an unrelated event that matches none of the admitted patterns', async () => {
      const orderId = await nextOrder();
      const audit = await withHistory.client.query<{ audit_id: string }>(`
        INSERT INTO audit_log(event,entity_type,entity_id,related_order_id)
        VALUES ('users.password_change','user','irrelevant',$1) RETURNING audit_id`,
      [orderId]);
      const auditId = audit.rows[0]!.audit_id;

      const events = await withHistory.client.query(`
        SELECT 1 FROM mdf_board_history_events WHERE event_key='audit:' || $1 || ':order:' || $2::text`,
      [auditId, orderId]);
      expect(events.rows).toEqual([]);
    });

    it("resolves an mdf_bath entity 'cut-result:7' to subject bath/cut-result:7", async () => {
      const orderId = await nextOrder();
      const audit = await withHistory.client.query<{ audit_id: string }>(`
        INSERT INTO audit_log(event,entity_type,entity_id,related_order_id)
        VALUES ('mdf.order_correction.requested','mdf_bath','cut-result:7',$1) RETURNING audit_id`,
      [orderId]);
      const auditId = audit.rows[0]!.audit_id;

      const events = await withHistory.client.query<{ subject_kind: string; subject_id: string }>(`
        SELECT subject_kind,subject_id FROM mdf_board_history_events
        WHERE event_key='audit:' || $1 || ':order:' || $2::text`, [auditId, orderId]);
      expect(events.rows).toEqual([{ subject_kind: 'bath', subject_id: 'cut-result:7' }]);
    });
  });
});

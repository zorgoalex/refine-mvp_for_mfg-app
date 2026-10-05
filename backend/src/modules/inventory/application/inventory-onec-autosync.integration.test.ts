import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import { PgOnecRepository } from '../../onec-agent/adapters/pg-onec-repository';
import { OnecAlertsPort } from '../../onec-agent/application/onec-alerts-port';
import { OnecEtlEvents } from '../../onec-agent/application/onec-etl-events';
import { OnecCatalogReader } from '../../onec-agent/onec-catalog-reader';
import { OnecRuntimeConfigService } from '../../onec-agent/onec-runtime-config.service';
import { AUTOSYNC_ALERT_KIND, InventoryOnecAutosyncService } from './inventory-onec-autosync.service';
import { InventoryService } from './inventory.service';

// Автосинхронизация складов 1С → ERP (план 2026-09-29-onec-warehouse-autosync-plan.md): настоящий
// InventoryService/OnecCatalogReader, пул из ОДНОГО соединения (проверка сброса app.user_id на том же
// соединении), второе соединение — для гонки с выгрузкой. Только собственная одноразовая БД film_catalog_it_*.
const url = process.env.FILM_CATALOG_TEST_DATABASE_URL;

describe.skipIf(!url)('warehouse autosync from 1C — real PostgreSQL, pool of one connection', { timeout: 90000 }, () => {
  let database: DatabaseService;
  let watcher: Client;
  let events: OnecEtlEvents;
  let alerts: OnecAlertsPort;
  let reader: OnecCatalogReader;
  let inventory: InventoryService;
  let autosync: InventoryOnecAutosyncService;
  let serviceUserId = 0;
  let adminId = 0;
  let source1 = 0;
  let source2 = 0;
  const tag = 'E2E-Тест-автосинхр-' + randomUUID().slice(0, 8);
  const keys = { a: randomUUID(), b: randomUUID(), group: randomUUID(), c: randomUUID(), d: randomUUID(), other: randomUUID(), sig: randomUUID(), boom: randomUUID(), par: randomUUID(), btn: randomUUID() };

  const makeConfig = (overrides: Partial<BackendEnv> = {}) =>
    new ConfigService<BackendEnv, true>({
      DATABASE_URL: url, DATABASE_POOL_MIN: 1, DATABASE_POOL_MAX: 1, DATABASE_SSL: false, DATABASE_QUERY_TIMEOUT_MS: 15000,
      BACKEND_INVENTORY_ENABLED: true, BACKEND_ENABLE_ONEC_AGENT: true, ONEC_CLIENT_CERT_HEADER: 'x-client-cert',
      BACKEND_INVENTORY_ONEC_AUTOSYNC: true, BACKEND_INVENTORY_ONEC_AUTOSYNC_ACTOR_USER_ID: serviceUserId,
      ...overrides,
    } as Partial<BackendEnv>);
  const makeAutosync = (config: ConfigService<BackendEnv, true>) =>
    new InventoryOnecAutosyncService(database, config, new InventoryService(database, config, reader), reader, events, alerts);

  const mirrorRow = (source: number, key: string, name: string, kind = 'Склад') =>
    watcher.query(
      `INSERT INTO onec_etl_mirror_rows (source_id, entity_code, source_key, deleted, data, row_hash, first_seen_run, last_run_id)
       VALUES ($1, 'warehouses', $2, false, $3::jsonb, md5($3::text), gen_random_uuid(), gen_random_uuid())`,
      [source, key, JSON.stringify({ Ref_Key: key, Code: 'IT', Description: name, DeletionMark: false, ТипСтруктурнойЕдиницы: kind })],
    );
  const ours = async () =>
    (await watcher.query<{ warehouse_name: string; ref_key_1c: string; created_by: string; edited_by: string }>(
      `SELECT warehouse_name, ref_key_1c::text AS ref_key_1c, created_by::text AS created_by, edited_by::text AS edited_by
         FROM warehouses WHERE warehouse_name LIKE $1 ORDER BY warehouse_name`,
      [`${tag}%`],
    )).rows;
  const state = async (source: number) =>
    (await watcher.query(`SELECT last_seq::int, finished_seq::int, last_outcome, last_error_code FROM inventory_onec_autosync_state WHERE source_id = $1`, [source])).rows[0];
  const alert = async (source: number) =>
    (await watcher.query(`SELECT state, details FROM onec_alerts WHERE dedupe_key = $1`, [`${AUTOSYNC_ALERT_KIND}:${source}`])).rows[0];
  const runTrigger = (source: number, runId = randomUUID()) => ({ kind: 'run' as const, sourceId: source, runId, requestId: `req-${runId}`, correlationId: `corr-${runId}` });

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
    if (!dbName.startsWith('film_catalog_it_')) throw new Error(`owned film_catalog_it_* database required (got ${dbName})`);
    watcher = new Client({ connectionString: url });
    await watcher.connect();
    const service = await watcher.query<{ role_id: number }>("SELECT role_id FROM roles WHERE role_code = 'integration_service'");
    const admin = await watcher.query<{ role_id: number }>('SELECT min(role_id) AS role_id FROM roles');
    const insertUser = async (suffix: string, roleId: number, serviceAccount: boolean) =>
      Number((await watcher.query<{ user_id: string }>(
        `INSERT INTO users (username, email, password_hash, role_id, full_name, is_service_account)
         VALUES ($1, $2, 'test-hash', $3, $4, $5) RETURNING user_id`,
        [`${tag}-${suffix}`, `${randomUUID()}@example.invalid`, roleId, `${tag} ${suffix}`, serviceAccount],
      )).rows[0].user_id);
    serviceUserId = await insertUser('onec-sync', service.rows[0].role_id, true);
    adminId = await insertUser('admin', admin.rows[0].role_id, false);
    const newSource = async (suffix: string) => {
      const id = Number((await watcher.query<{ source_id: string }>(
        'INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id',
        [`it-${randomUUID().slice(0, 8)}`, `${tag} ${suffix}`],
      )).rows[0].source_id);
      await watcher.query(
        'INSERT INTO onec_agents (agent_id, source_id, site_id, display_name) VALUES ($1, $2, $3, $4)',
        [`it-${randomUUID().slice(0, 12)}`, id, 'it', `${tag} агент ${suffix}`],
      );
      await watcher.query("INSERT INTO onec_etl_entity_state (source_id, entity_code) VALUES ($1, 'warehouses')", [id]);
      return id;
    };
    source1 = await newSource('база 1');
    source2 = await newSource('база 2');
    await mirrorRow(source1, keys.a, `${tag} Цех А`);
    await mirrorRow(source1, keys.b, `${tag} Цех Б`);
    await mirrorRow(source1, keys.group, `${tag} Группа`, 'МагазинГруппаСкладов');
    await mirrorRow(source2, keys.other, `${tag} Чужая база`);
    const config = makeConfig();
    database = new DatabaseService(config, { measure: (_text: string, run: () => Promise<unknown>) => run() } as never);
    events = new OnecEtlEvents();
    alerts = new OnecAlertsPort(new PgOnecRepository(database));
    reader = new OnecCatalogReader(database, new OnecRuntimeConfigService(config));
    inventory = new InventoryService(database, config, reader);
    autosync = new InventoryOnecAutosyncService(database, config, inventory, reader, events, alerts);
  });

  afterAll(async () => {
    await database?.onModuleDestroy();
    await watcher?.end();
  });

  it('creates the source warehouses as the service user with the run correlation; the pooled connection keeps no app.user_id', async () => {
    const trigger = runTrigger(source1);
    const outcome = await autosync.run(trigger);
    expect(outcome).toMatchObject({ status: 'succeeded', replayed: false, created: 2, linked: 0, skipped: 0 });
    const rows = await ours();
    expect(rows.map((r) => [r.warehouse_name, r.ref_key_1c])).toEqual([[`${tag} Цех А`, keys.a], [`${tag} Цех Б`, keys.b]]);
    expect(rows.every((r) => r.created_by === String(serviceUserId) && r.edited_by === String(serviceUserId))).toBe(true);
    const audit = (await watcher.query(
      `SELECT user_id::text AS actor, role_code AS actor_role, source, request_id, metadata_json->>'correlationId' AS correlation
         FROM audit_log WHERE event = 'inventory.warehouse_created' AND request_id = $1`,
      [trigger.requestId],
    )).rows;
    expect(audit).toHaveLength(2);
    expect(audit.every((a) => a.actor === String(serviceUserId) && a.actor_role === 'integration_service'
      && a.source === 'onec_autosync' && a.correlation === trigger.correlationId)).toBe(true);
    const outbox = (await watcher.query(
      `SELECT payload_json->>'source' AS source, payload_json->>'correlationId' AS correlation FROM outbox_events
        WHERE idempotency_key LIKE $1`,
      [`%:onec-autosync:${source1}:${trigger.runId}`],
    )).rows;
    expect(outbox).toEqual([{ source: 'onec_autosync', correlation: trigger.correlationId }, { source: 'onec_autosync', correlation: trigger.correlationId }]);
    expect(await state(source1)).toEqual({ last_seq: 1, finished_seq: 1, last_outcome: 'succeeded', last_error_code: null });
    // Пул из одного соединения: следующая команда на нём не наследует служебного исполнителя.
    const setting = await database.query<{ v: string | null }>("SELECT current_setting('app.user_id', true) AS v");
    expect(setting.rows[0].v ?? '').toBe('');
  });

  it('a replay of the same run is a no-op: no new audit, the state and the alert are not touched', async () => {
    const trigger = runTrigger(source1, randomUUID());
    await autosync.run(trigger);
    const before = (await watcher.query(`SELECT count(*)::int AS n FROM audit_log WHERE event LIKE 'inventory.warehouse_%'`)).rows[0].n;
    const seqBefore = await state(source1);
    const replay = await autosync.run(trigger);
    expect(replay).toMatchObject({ status: 'succeeded', replayed: true });
    expect((await watcher.query(`SELECT count(*)::int AS n FROM audit_log WHERE event LIKE 'inventory.warehouse_%'`)).rows[0].n).toBe(before);
    expect((await state(source1)).finished_seq).toBe(seqBefore.finished_seq);
  });

  it('does nothing while the autosync flag or the inventory flag is off', async () => {
    const seq = await state(source1);
    expect(await makeAutosync(makeConfig({ BACKEND_INVENTORY_ONEC_AUTOSYNC: false })).run(runTrigger(source1))).toEqual({ status: 'skipped', reason: 'disabled' });
    expect(await makeAutosync(makeConfig({ BACKEND_INVENTORY_ENABLED: false })).run(runTrigger(source1))).toEqual({ status: 'skipped', reason: 'disabled' });
    expect(await state(source1)).toEqual(seq);
  });

  it('an actor that is not a ready service account fails with an alert; the next success closes it; seq always grows', async () => {
    await mirrorRow(source1, keys.c, `${tag} Цех В`);
    const bad = makeAutosync(makeConfig({ BACKEND_INVENTORY_ONEC_AUTOSYNC_ACTOR_USER_ID: adminId }));
    const failed = await bad.run(runTrigger(source1));
    expect(failed).toMatchObject({ status: 'failed', code: 'ACTOR_NOT_READY' });
    expect((await ours()).map((r) => r.ref_key_1c)).not.toContain(keys.c);
    expect(await alert(source1)).toMatchObject({ state: 'open', details: { code: 'ACTOR_NOT_READY', seq: failed.status === 'failed' ? failed.seq : -1 } });
    const ok = await autosync.run(runTrigger(source1));
    expect(ok).toMatchObject({ status: 'succeeded', created: 1 });
    expect(ok.status === 'succeeded' && failed.status === 'failed' && ok.seq > failed.seq).toBe(true);
    expect((await alert(source1)).state).toBe('resolved');
  });

  it('only the newest finished run writes the outcome: a late success never closes a newer failure', async () => {
    const internals = autosync as unknown as {
      allocateSeq(source: number): Promise<number>;
      finish(tx: DatabaseClient, source: number, seq: number, outcome: Record<string, unknown>): Promise<void>;
    };
    const older = await internals.allocateSeq(source1);
    const newer = await internals.allocateSeq(source1);
    await database.transaction((tx) => internals.finish(tx, source1, newer, { ok: false, code: 'E2E_NEWER_FAILED', message: 'E2E' }));
    await database.transaction((tx) => internals.finish(tx, source1, older, { ok: true, created: 0, linked: 0, skipped: 0 }));
    expect(await state(source1)).toMatchObject({ finished_seq: newer, last_outcome: 'failed', last_error_code: 'E2E_NEWER_FAILED' });
    expect((await alert(source1)).state).toBe('open');
    await autosync.run(runTrigger(source1));
    expect((await alert(source1)).state).toBe('resolved');
  });

  it('waits for a concurrent ETL completion and never creates a warehouse from a row it deleted', async () => {
    await mirrorRow(source1, keys.d, `${tag} Цех Г`);
    await watcher.query('BEGIN');
    let open = true;
    try {
      await watcher.query("SELECT 1 FROM onec_etl_entity_state WHERE source_id = $1 AND entity_code = 'warehouses' FOR UPDATE", [source1]);
      const pending = autosync.run(runTrigger(source1));
      let waiting = false;
      for (let i = 0; i < 50 && !waiting; i += 1) {
        // pg_stat_activity внутри транзакции — снимок; сбрасываем его перед каждой проверкой.
        await watcher.query('SELECT pg_stat_clear_snapshot()');
        const rows = await watcher.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE '%onec_etl_entity_state%FOR SHARE%' AND pid <> pg_backend_pid()`,
        );
        waiting = Number(rows.rows[0].n) > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(waiting).toBe(true);
      await watcher.query(`UPDATE onec_etl_mirror_rows SET data = jsonb_set(data, '{DeletionMark}', 'true') WHERE source_id = $1 AND source_key = $2`, [source1, keys.d]);
      await watcher.query('COMMIT');
      open = false;
      expect(await pending).toMatchObject({ status: 'succeeded', created: 0 });
    } finally {
      if (open) await watcher.query('ROLLBACK');
    }
    expect((await ours()).map((r) => r.ref_key_1c)).not.toContain(keys.d);
  });

  it('a run of one source never creates another source’s warehouses; the hourly trigger does, and repeats as a replay', async () => {
    await autosync.run(runTrigger(source1));
    expect((await ours()).map((r) => r.ref_key_1c)).not.toContain(keys.other);
    const hour = new Date().toISOString().slice(0, 13).replace(/[-T]/g, '');
    const first = await autosync.run({ kind: 'hourly', sourceId: source2, hour });
    expect(first).toMatchObject({ status: 'succeeded', created: 1, replayed: false });
    expect((await ours()).map((r) => r.ref_key_1c)).toContain(keys.other);
    expect(await autosync.run({ kind: 'hourly', sourceId: source2, hour })).toMatchObject({ status: 'succeeded', replayed: true });
  });

  it('runs on the published-warehouses signal once the module is initialized', async () => {
    await mirrorRow(source1, keys.sig, `${tag} Цех Сигнал`);
    autosync.onModuleInit();
    try {
      events.emitWarehousesPublished({ sourceId: source1, runId: randomUUID(), requestId: 'req-signal', correlationId: 'corr-signal' });
      let created = false;
      for (let i = 0; i < 50 && !created; i += 1) {
        created = (await ours()).some((r) => r.ref_key_1c === keys.sig);
        if (!created) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(created).toBe(true);
    } finally {
      autosync.onModuleDestroy();
    }
  });

  it('a failure after the actor is set rolls back and leaves the connection with its previous app.user_id', async () => {
    await mirrorRow(source1, keys.boom, `${tag} Цех Сбой`);
    await watcher.query(`CREATE FUNCTION it_autosync_boom() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF NEW.warehouse_name LIKE '%Цех Сбой' THEN RAISE EXCEPTION 'E2E boom'; END IF; RETURN NEW; END $f$`);
    await watcher.query('CREATE TRIGGER it_autosync_boom BEFORE INSERT ON warehouses FOR EACH ROW EXECUTE FUNCTION it_autosync_boom()');
    try {
      // Значение, оставленное предыдущей пользовательской командой на этом соединении пула.
      await database.query("SELECT set_config('app.user_id', $1, false)", [String(adminId)]);
      const failed = await autosync.run(runTrigger(source1));
      expect(failed).toMatchObject({ status: 'failed', code: 'AUTOSYNC_ERROR' });
      const setting = await database.query<{ v: string | null }>("SELECT current_setting('app.user_id', true) AS v");
      expect(setting.rows[0].v).toBe(String(adminId));
      expect((await ours()).map((r) => r.ref_key_1c)).not.toContain(keys.boom);
      expect(await alert(source1)).toMatchObject({ state: 'open', details: { code: 'AUTOSYNC_ERROR' } });
    } finally {
      await watcher.query('DROP TRIGGER IF EXISTS it_autosync_boom ON warehouses');
      await watcher.query('DROP FUNCTION IF EXISTS it_autosync_boom()');
    }
    expect(await autosync.run(runTrigger(source1))).toMatchObject({ status: 'succeeded', created: 1 });
    expect((await alert(source1)).state).toBe('resolved');
  });

  it('concurrent autosyncs and an autosync racing the button create the warehouse once, with one audit row', async () => {
    const config = makeConfig();
    const second = new DatabaseService(config, { measure: (_text: string, run: () => Promise<unknown>) => run() } as never);
    try {
      const reader2 = new OnecCatalogReader(second, new OnecRuntimeConfigService(config));
      const inventory2 = new InventoryService(second, config, reader2);
      const autosync2 = new InventoryOnecAutosyncService(second, config, inventory2, reader2, events, new OnecAlertsPort(new PgOnecRepository(second)));
      const created = async (key: string) =>
        (await watcher.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_log a JOIN warehouses w ON w.warehouse_id::text = a.entity_id
            WHERE a.event = 'inventory.warehouse_created' AND w.ref_key_1c = $1::uuid`,
          [key],
        )).rows[0].n;

      await mirrorRow(source1, keys.par, `${tag} Цех Параллель`);
      const [one, two] = await Promise.all([autosync.run(runTrigger(source1)), autosync2.run(runTrigger(source1))]);
      expect([one.status, two.status]).toEqual(['succeeded', 'succeeded']);
      expect((one.status === 'succeeded' ? one.created : 0) + (two.status === 'succeeded' ? two.created : 0)).toBe(1);
      expect((await ours()).filter((r) => r.ref_key_1c === keys.par)).toHaveLength(1);
      expect(await created(keys.par)).toBe(1);
      const finished = await state(source1);
      expect(finished.finished_seq).toBe(finished.last_seq);
      expect((await alert(source1)).state).toBe('resolved');

      await mirrorRow(source1, keys.btn, `${tag} Цех Кнопка`);
      const user = { id: String(adminId), username: `${tag}-admin`, role: 'admin', roleId: 1, permissions: ['inventory.view', 'inventory.manage'] } as never;
      const [auto, button] = await Promise.all([
        autosync.run(runTrigger(source1)),
        inventory2.syncWarehousesFromOnec({ currentUser: user, requestId: `req-${randomUUID()}`, idempotencyKey: randomUUID() }),
      ]);
      expect(auto.status).toBe('succeeded');
      expect((auto.status === 'succeeded' ? auto.created : 0) + button.created.filter((w) => w.refKey1c === keys.btn).length).toBe(1);
      expect((await ours()).filter((r) => r.ref_key_1c === keys.btn)).toHaveLength(1);
      expect(await created(keys.btn)).toBe(1);
    } finally {
      await second.onModuleDestroy();
    }
  });
});

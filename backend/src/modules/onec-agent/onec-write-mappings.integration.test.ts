import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../../permissions/current-user';
import type { PerformanceQueryTelemetryService } from '../../performance/performance-query-telemetry.service';
import { PgOnecRepository } from './adapters/pg-onec-repository';
import { OnecAuditWriter } from './application/onec-audit';
import { OnecWriteMappingsService } from './application/onec-write-mappings.service';
import type { OnecRuntimeConfigService } from './onec-runtime-config.service';

const suite = process.env.ONEC_AGENT_DOCKER_TEST === 'true' ? describe : describe.skip;
const runtime = { get: () => ({ enabled: true }), requireEnabled: () => undefined } as unknown as OnecRuntimeConfigService;
const actor = { id: '7', username: 'admin-e2e', role: 'admin', permissions: [] } as unknown as CurrentUser;
const ctx = { requestId: 'E2E-Тест-mapping', correlationId: null };

/** Only the table block of migration 293 (its permission part writes the shared public catalog). */
function tableDdl(): string {
  const sql = readFileSync(new URL('../../../db/migrations/293_onec_write_mappings.sql', import.meta.url), 'utf8');
  const start = sql.indexOf('CREATE SEQUENCE IF NOT EXISTS onec_write_mappings_version_seq');
  const end = sql.indexOf('COMMENT ON TABLE onec_write_mappings');
  if (start < 0 || end < 0) throw new Error('migration 293 layout changed');
  return sql.slice(start, end);
}

suite('ERP → 1C write mappings (plan 2026-11-04 §8.2) — isolated PostgreSQL', () => {
  const schema = `e2e_onec_wmap_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let db: DatabaseService;
  let service: OnecWriteMappingsService;

  beforeAll(async () => {
    const [container] = JSON.parse(execFileSync('docker', ['inspect', 'erp_test-postgresdb-1'], { encoding: 'utf8' }));
    const env = Object.fromEntries(container.Config.Env.map((entry: string) => { const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)]; }));
    const network = Object.values(container.NetworkSettings.Networks)[0] as { IPAddress: string };
    const url = new URL(`postgresql://${network.IPAddress}:5432/${env.POSTGRES_DB ?? 'erpdb'}`);
    url.username = env.POSTGRES_USER;
    url.password = env.POSTGRES_PASSWORD;
    url.searchParams.set('options', `-c search_path=${schema},public,pg_catalog -c jit=off`);
    pool = new Pool({ connectionString: url.toString(), max: 4 });
    await pool.query(`CREATE SCHEMA ${schema}; SET search_path = ${schema}, public;
      CREATE TABLE users(user_id bigint PRIMARY KEY, username text, full_name text, is_active boolean DEFAULT true, is_service_account boolean DEFAULT false);
      CREATE TABLE order_statuses(order_status_id int PRIMARY KEY, order_status_name text, sort_order int, is_active boolean DEFAULT true);
      CREATE TABLE production_statuses(production_status_id int PRIMARY KEY, production_status_name text, sort_order int, is_active boolean DEFAULT true);
      CREATE TABLE workshops(workshop_id int PRIMARY KEY, workshop_name text, sort_order int, is_active boolean DEFAULT true);
      CREATE TABLE payment_types(type_paid_id int PRIMARY KEY, type_paid_name text, sort_order int, is_active boolean DEFAULT true);
      CREATE TABLE milling_types(milling_type_id int PRIMARY KEY, milling_type_name text, sort_order int, is_active boolean DEFAULT true);
      CREATE TABLE sheet_material_types(sheet_material_type_id int PRIMARY KEY, name text, is_active boolean DEFAULT true);
      CREATE TABLE audit_log(LIKE public.audit_log INCLUDING ALL);
      CREATE TABLE audit_log_related_entity(LIKE public.audit_log_related_entity INCLUDING ALL);`);
    for (const file of ['193_onec_agent_foundation.sql', '196_onec_agent_commands.sql', '198_onec_etl.sql', '200_onec_etl_snapshots_revocation.sql']) {
      await pool.query(`SET search_path = ${schema}, public; ${readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), 'utf8')}`);
    }
    await pool.query(`SET search_path = ${schema}, public; ${tableDdl()}`);
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(), DATABASE_QUERY_TIMEOUT_MS: 20000, DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 4, DATABASE_SSL: false };
    db = new DatabaseService(
      { get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv, true>,
      { measure: <T>(_sql: string, op: () => Promise<T>) => op() } as PerformanceQueryTelemetryService,
    );
    const repository = new PgOnecRepository(db);
    service = new OnecWriteMappingsService(db, repository, runtime, new OnecAuditWriter(repository));
  }, 60000);

  afterAll(async () => {
    await db?.onModuleDestroy();
    if (pool) {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    }
  });

  const R = { stateWork: randomUUID(), stateDone: randomUUID(), shift1: randomUUID(), user1C: randomUUID(), emp: randomUUID(),
    cash: randomUUID(), bankOwn: randomUUID(), bankForeign: randomUUID(), item: randomUUID(), folder: randomUUID(), deletedItem: randomUUID() };
  const run = randomUUID();
  const mirror = (entity: string, key: string, data: Record<string, unknown>, deleted = false) =>
    pool.query(
      `INSERT INTO ${schema}.onec_etl_mirror_rows (source_id, entity_code, source_key, deleted, data, row_hash, first_seen_run, last_run_id)
       VALUES (1, $1, $2, $3, $4::jsonb, 'h', $5, $5)`,
      [entity, key, deleted, JSON.stringify(data), run],
    );

  beforeEach(async () => {
    await pool.query(`SET search_path = ${schema}, public;
      DELETE FROM audit_log_related_entity; DELETE FROM audit_log;
      TRUNCATE onec_write_mappings, onec_etl_mirror_rows, onec_agents, onec_sources, users, order_statuses,
        production_statuses, workshops, payment_types, milling_types, sheet_material_types RESTART IDENTITY CASCADE;
      INSERT INTO onec_sources (code, display_name) VALUES ('a', 'Тест');
      INSERT INTO onec_agents (agent_id, source_id, site_id, display_name) VALUES ('agent-a', 1, 's', 'E2E');
      INSERT INTO users VALUES (7, 'admin-e2e', 'Админ Тест', true, false), (8, 'svc', 'Служебная', true, true), (9, 'old', 'Уволен', false, false);
      INSERT INTO order_statuses VALUES (1, 'Оформлен', 1, true), (2, 'Завершен', 2, true), (3, 'Старый', 3, false);
      INSERT INTO production_statuses VALUES (1, 'Новый', 1), (2, 'Распилен', 2);
      INSERT INTO workshops VALUES (3, 'Цех 3 ЧПУ', 1);
      INSERT INTO payment_types VALUES (2, 'нал', 1), (64, 'Каспи ТОО', 2);
      INSERT INTO milling_types VALUES (5, 'Модерн', 1);
      INSERT INTO sheet_material_types VALUES (11, 'МДФ 16');`);
    await mirror('order_states', R.stateWork, { Description: 'В работе', DeletionMark: false });
    await mirror('order_states', R.stateDone, { Description: 'Завершен', DeletionMark: false });
    await mirror('order_states', R.shift1, { Description: '1 смена В производстве', DeletionMark: false });
    await mirror('users', R.user1C, { Description: 'Пользователь 1С', DeletionMark: false, Служебный: false, Недействителен: false });
    await mirror('employees', R.emp, { Description: 'Сотрудник 1С', DeletionMark: false, IsFolder: false, Недействителен: false });
    await mirror('cash_desks', R.cash, { Description: 'Касса', DeletionMark: false });
    await mirror('bank_accounts', R.bankOwn, { Description: 'Счёт организации', DeletionMark: false, Owner_Type: 'StandardODATA.Catalog_Организации' });
    await mirror('bank_accounts', R.bankForeign, { Description: 'Счёт контрагента', DeletionMark: false, Owner_Type: 'StandardODATA.Catalog_Контрагенты' });
    await mirror('items', R.item, { Description: 'Фрезировка 16 мм Модерн', Code: 'НФ-1', DeletionMark: false, IsFolder: false });
    await mirror('items', R.folder, { Description: 'Плёнка', Code: 'НФ-2', DeletionMark: false, IsFolder: true });
    await mirror('items', R.deletedItem, { Description: 'Удалённая услуга', DeletionMark: true, IsFolder: false });
  });

  const put = (kind: string, erpKey: string, body: unknown) => service.put(actor, 'agent-a', kind, erpKey, body, ctx);

  it('lists every kind with active ERP items only (no service or inactive users, no inactive statuses) and counts missing', async () => {
    const { kinds } = await service.list('agent-a');
    const byKind = Object.fromEntries(kinds.map((kind) => [kind.kind, kind]));
    expect(byKind.order_status.items.map((item) => item.erpKey)).toEqual(['order_status:1', 'order_status:2']);
    expect(byKind.user_author.items.map((item) => item.erpKey)).toEqual(['user:7']);
    expect(byKind.shift_state.items.map((item) => item.erpKey)).toEqual(['shift:1', 'shift:2', 'shift:3']);
    expect(byKind.order_status.missing).toBe(2);
    // «Цеха» are not mirrored yet: no candidates and the note says why.
    expect([byKind.workshop.candidatesCount, typeof byKind.workshop.pendingNote]).toEqual([0, 'string']);
    expect(byKind.production_stage.hasRef).toBe(false);
  });

  it('candidates are live mirror rows of the kind: own bank accounts only, no folders for services, no deleted rows', async () => {
    const accounts = (await service.candidates('agent-a', 'payment_type_account', undefined)).data.map((row) => row.ref);
    expect(accounts.sort()).toEqual([R.cash, R.bankOwn].sort());
    const services = (await service.candidates('agent-a', 'milling_nomenclature', 'фрез')).data.map((row) => row.ref);
    expect(services).toEqual([R.item]);
    expect((await service.candidates('agent-a', 'film_group', undefined)).data.map((row) => row.ref)).toEqual([R.folder]);
    expect((await service.candidates('agent-a', 'milling_nomenclature', '%')).data).toEqual([]); // literal search
  });

  it('sets, updates and clears a mapping with optimistic versions and one audit row per change', async () => {
    const created = await put('order_status', 'order_status:2', { onecRef: R.stateDone, onecValue: { completion: 'Успешно' }, expectedVersion: null });
    expect(created).toMatchObject({ changed: true, mapping: { onecRef: R.stateDone, onecName: 'Завершен', onecValue: { completion: 'Успешно' }, onecRefStale: false } });
    const v1 = created.mapping!.version;
    await expect(put('order_status', 'order_status:2', { onecRef: R.stateWork, onecValue: null, expectedVersion: null }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ONEC_MAPPING_CHANGED' });
    const same = await put('order_status', 'order_status:2', { onecRef: R.stateDone, onecValue: { completion: 'Успешно' }, expectedVersion: v1 });
    expect(same.changed).toBe(false);
    const updated = await put('order_status', 'order_status:2', { onecRef: R.stateWork, onecValue: null, expectedVersion: v1 });
    expect(updated.mapping!.onecRef).toBe(R.stateWork);
    const v2 = updated.mapping!.version;
    expect(v2).toBeGreaterThan(v1);
    const cleared = await put('order_status', 'order_status:2', { onecRef: null, onecValue: null, expectedVersion: v2 });
    expect(cleared).toEqual({ changed: true, mapping: null });
    const audit = await pool.query(`SELECT event, entity_id, metadata_json->>'operation' AS op FROM ${schema}.audit_log ORDER BY created_at, audit_id`);
    expect(audit.rows.map((row) => row.op)).toEqual(['create', 'update', 'clear']);
    expect(audit.rows[0]).toMatchObject({ event: 'onec.mapping.changed', entity_id: '1:order_status:order_status:2' });
  });

  it('refuses refs outside the kind (foreign bank account, folder for a service, deleted item) and unknown ERP items', async () => {
    await expect(put('payment_type_account', 'payment_type:64', { onecRef: R.bankForeign, onecValue: null, expectedVersion: null }))
      .rejects.toMatchObject({ statusCode: 422, code: 'ONEC_MAPPING_REF_INVALID' });
    await expect(put('milling_nomenclature', 'milling_type:5', { onecRef: R.folder, onecValue: null, expectedVersion: null }))
      .rejects.toMatchObject({ statusCode: 422 });
    await expect(put('milling_nomenclature', 'milling_type:5', { onecRef: R.deletedItem, onecValue: null, expectedVersion: null }))
      .rejects.toMatchObject({ statusCode: 422 });
    await expect(put('order_status', 'order_status:3', { onecRef: R.stateWork, onecValue: null, expectedVersion: null }))
      .rejects.toMatchObject({ statusCode: 404, code: 'ONEC_MAPPING_ITEM_NOT_FOUND' });
    await expect(put('user_author', 'user:8', { onecRef: R.user1C, onecValue: null, expectedVersion: null }))
      .rejects.toMatchObject({ statusCode: 404 }); // service account is not an ERP item
  });

  it('production stages take a fixed 1C value only (or empty), never a ref', async () => {
    const saved = await put('production_stage', 'production_status:2', { onecRef: null, onecValue: { productionStatus: 'ВРаботе' }, expectedVersion: null });
    expect(saved.mapping).toMatchObject({ onecRef: null, onecValue: { productionStatus: 'ВРаботе' } });
    const empty = await put('production_stage', 'production_status:1', { onecRef: null, onecValue: { productionStatus: null }, expectedVersion: null });
    expect(empty.mapping?.onecValue).toEqual({ productionStatus: null });
    await expect(put('production_stage', 'production_status:1', { onecRef: null, onecValue: { productionStatus: 'Другое' }, expectedVersion: empty.mapping!.version }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(put('production_stage', 'production_status:1', { onecRef: R.stateWork, onecValue: null, expectedVersion: empty.mapping!.version }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('a mapped ref that later disappears from the mirror is shown as stale', async () => {
    await put('milling_nomenclature', 'milling_type:5', { onecRef: R.item, onecValue: null, expectedVersion: null });
    await pool.query(`UPDATE ${schema}.onec_etl_mirror_rows SET data = data || '{"DeletionMark": true}' WHERE source_key = $1`, [R.item]);
    const { kinds } = await service.list('agent-a');
    const item = kinds.find((kind) => kind.kind === 'milling_nomenclature')!.items[0];
    expect(item.mapping).toMatchObject({ onecRef: R.item, onecRefStale: true });
  });

  it('two concurrent first saves: exactly one wins, the other gets 409, and the audit says one «create»', async () => {
    const results = await Promise.allSettled([
      put('order_status', 'order_status:1', { onecRef: R.stateWork, onecValue: null, expectedVersion: null }),
      put('order_status', 'order_status:1', { onecRef: R.stateDone, onecValue: null, expectedVersion: null }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 409, code: 'ONEC_MAPPING_CHANGED' });
    const audit = await pool.query(`SELECT metadata_json->>'operation' AS op, before_json FROM ${schema}.audit_log`);
    expect(audit.rows).toEqual([{ op: 'create', before_json: null }]);
  });

  it('a stale editor cannot update or clear a mapping that was cleared and re-created (versions are never reused)', async () => {
    const first = await put('order_status', 'order_status:1', { onecRef: R.stateWork, onecValue: null, expectedVersion: null });
    const stale = first.mapping!.version;
    await put('order_status', 'order_status:1', { onecRef: null, onecValue: null, expectedVersion: stale });
    const again = await put('order_status', 'order_status:1', { onecRef: R.stateDone, onecValue: null, expectedVersion: null });
    expect(again.mapping!.version).not.toBe(stale);
    await expect(put('order_status', 'order_status:1', { onecRef: R.stateWork, onecValue: null, expectedVersion: stale }))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(put('order_status', 'order_status:1', { onecRef: null, onecValue: null, expectedVersion: stale }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('audit rows carry actor, request id, the normalized ERP entity, before/after/diff; a refused change writes nothing', async () => {
    await put('user_author', 'user:7', { onecRef: R.user1C, onecValue: null, expectedVersion: null });
    const row = (await pool.query(
      `SELECT a.user_id::text, a.username, a.request_id, a.related_user_id::text, a.after_json, a.diff_json,
              (SELECT json_agg(json_build_object('t', r.entity_type, 'id', r.entity_id::text)) FROM ${schema}.audit_log_related_entity r WHERE r.audit_id = a.audit_id) AS rel
         FROM ${schema}.audit_log a`)).rows;
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ user_id: '7', username: 'admin-e2e', request_id: 'E2E-Тест-mapping', related_user_id: '7',
      after_json: { onecRef: R.user1C, onecValue: null }, diff_json: { onecRef: { from: null, to: R.user1C } } });
    expect(row[0].rel).toEqual([{ t: 'user', id: '7' }]);
    await expect(put('user_author', 'user:7', { onecRef: R.user1C, onecValue: null, expectedVersion: 999999 })).rejects.toMatchObject({ statusCode: 409 });
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.audit_log`)).rows[0].n).toBe(1);
  });

  it('a mapped 1C object that stops being eligible for the kind (user marked «Недействителен») counts as invalid, not ready', async () => {
    await put('user_author', 'user:7', { onecRef: R.user1C, onecValue: null, expectedVersion: null });
    let kind = (await service.list('agent-a')).kinds.find((k) => k.kind === 'user_author')!;
    expect([kind.missing, kind.invalid, kind.ready]).toEqual([0, 0, true]);
    await pool.query(`UPDATE ${schema}.onec_etl_mirror_rows SET data = data || '{"Недействителен": true}' WHERE source_key = $1`, [R.user1C]);
    kind = (await service.list('agent-a')).kinds.find((k) => k.kind === 'user_author')!;
    expect([kind.missing, kind.invalid, kind.ready]).toEqual([0, 1, false]);
    expect(kind.items[0].mapping).toMatchObject({ onecRef: R.user1C, onecRefStale: true });
  });
});

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../../database/database.types';
import * as sourceRuntime from './status-automation-runtime';
import { loadRulesForPinnedExecution } from '../adapters/pg-status-automation-repository';
import type { PinnedMdfAutomationInput } from './mdf-pinned-batch';

const { evaluateProductionCompositionAutomation, executePinnedMdfAutomation }: typeof sourceRuntime = process.env.PRODUCTION_SUMMARY_TEST_USE_DIST === 'true'
  ? createRequire(import.meta.url)('../../../../dist/modules/status-automation/application/status-automation-runtime.js')
  : sourceRuntime;

// Real runtime, repository, PostgreSQL triggers and audit/outbox. Each test is
// isolated in its own rollback-only schema; no application rows or rules change.
const suite = process.env.PRODUCTION_SUMMARY_DOCKER_TEST === 'true' ? describe : describe.skip;
const migration = readFileSync(new URL('../../../../db/migrations/155_order_production_composition.sql', import.meta.url), 'utf8')
  .replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');

suite('production composition automation — real PostgreSQL', () => {
  let pool: Pool;
  beforeAll(() => {
    const [container] = JSON.parse(execFileSync('docker', ['inspect', 'erp_test-postgresdb-1'], { encoding: 'utf8' }));
    const env = Object.fromEntries(container.Config.Env.map((entry: string) => {
      const index = entry.indexOf('='); return [entry.slice(0, index), entry.slice(index + 1)];
    }));
    const network = Object.values(container.NetworkSettings.Networks)[0] as { IPAddress: string };
    pool = new Pool({ host: network.IPAddress, port: 5432, database: 'erpdb',
      user: env.POSTGRES_USER ?? 'postgres', password: env.POSTGRES_PASSWORD,
      max: 2, connectionTimeoutMillis: 5000, statement_timeout: 8000 });
    vi.stubEnv('BACKEND_STATUS_AUTOMATION', 'true');
  });
  afterAll(async () => { vi.unstubAllEnvs(); await pool?.end(); });

  async function fixture(run: (client: PoolClient, tx: TransactionClient) => Promise<void>) {
    const client = await pool.connect();
    const schema = `e2e_composition_runtime_${randomUUID().replaceAll('-', '')}`;
    try {
      await client.query(`BEGIN; CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema},public;
        CREATE TABLE orders (order_id bigint PRIMARY KEY, order_name text, client_id bigint,
          order_status_id integer DEFAULT 4, payment_status_id integer DEFAULT 1,
          production_status_id smallint, production_status_from_details_enabled boolean DEFAULT true,
          version integer DEFAULT 1, created_by bigint DEFAULT 1, manager_id bigint,
          delete_flag boolean DEFAULT false, order_kind text DEFAULT 'production_order',
          order_date date DEFAULT CURRENT_DATE, planned_completion_date date,
          final_amount numeric DEFAULT 0, paid_amount numeric DEFAULT 0, updated_at timestamptz DEFAULT now());
        CREATE TABLE order_details (detail_id bigint PRIMARY KEY, order_id bigint,
          production_status_id smallint, delete_flag boolean DEFAULT false, updated_at timestamptz);
        CREATE TABLE order_hdf_details (hdf_detail_id bigint, order_id bigint, production_status_id smallint);
        CREATE TABLE production_statuses (production_status_id smallint PRIMARY KEY, sort_order integer,
          production_status_name text, production_status_code text, is_active boolean DEFAULT true);
        CREATE TABLE order_statuses (order_status_id integer PRIMARY KEY, order_status_name text, is_active boolean DEFAULT true);
        CREATE TABLE bazis_order_links (order_id bigint);
        CREATE TABLE order_import_entity_map (local_order_id bigint);
        CREATE TABLE status_automation_rules (LIKE public.status_automation_rules INCLUDING ALL);
        CREATE TABLE audit_log (LIKE public.audit_log INCLUDING ALL);
        CREATE TABLE audit_log_related_entity (LIKE public.audit_log_related_entity INCLUDING ALL);
        CREATE TABLE outbox_events (LIKE public.outbox_events INCLUDING ALL);
        CREATE VIEW orders_view AS SELECT order_id, order_name FROM orders;
        INSERT INTO orders (order_id,order_name) VALUES (1,'E2E-Тест состав');
        INSERT INTO production_statuses VALUES (6,60,'Закатан','laminated',true),(7,70,'Упакован','packed',true),(22,100,'Завершен','completed',true);
        INSERT INTO order_statuses VALUES (4,'В производстве',true),(6,'Готов к выдаче',true);
        INSERT INTO order_details VALUES (11,1,7,false,now()),(12,1,NULL,false,now());
        INSERT INTO order_hdf_details VALUES (1,1,NULL);
        ${migration}
        INSERT INTO status_automation_rules
          (id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version)
        OVERRIDING SYSTEM VALUE
        VALUES (910001,'E2E-Тест uniform','order.production_status_changed','change_order_status',6,
          '{"currentProductionStatusIn":[7],"currentOrderStatusNotIn":[8]}',10,true,1),
          (910002,'E2E-Тест reverse echo trap','order.status_changed','change_details_production_status',22,
          '{"currentOrderStatusIn":[6]}',10,true,1);`);
      const tx = { raw: client, query: (sql: string, params: readonly unknown[] = []) => client.query(sql, [...params]) } as TransactionClient;
      await run(client, tx);
    } finally {
      await client.query('ROLLBACK');
      expect((await client.query('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].n).toBe(0);
      client.release();
    }
  }
  const input = () => ({ orderId: 1, actor: { id: '1', username: 'e2e-composition', role: 'admin', roleId: 1 },
    requestId: randomUUID(), sourceIdempotencyKey: randomUUID() });

  const pinnedInput = (downstream = false): PinnedMdfAutomationInput => ({
    ...input(), actor: { ...input().actor, role: 'admin', permissions: [] },
    pins: [{ ruleId: 910003, version: 1 }, ...(downstream ? [{ ruleId: 910001, version: 1 }] : [])],
    events: [{ eventType: 'mdf.board.completed', orderId: 1, scope: {
      source: { kind: 'packet', id: '11111111-1111-1111-1111-111111111111' },
      details: [{ detailId: 12, requiredQuantity: 10, eligibleQuantity: 10 }],
    } }],
  });
  const addMdfRule = (client: PoolClient) => client.query(`INSERT INTO status_automation_rules
    (id,name,event_type,action_type,target_status_id,conditions_json,priority,is_enabled,version)
    OVERRIDING SYSTEM VALUE VALUES (910003,'E2E-Тест MDF pinned','mdf.board.completed',
    'change_details_production_status',7,'{}',10,true,1)`);

  it('pinned MDF changes only its own eligible detail; later and partial positions survive', async () => fixture(async (client, tx) => {
    await addMdfRule(client);
    await client.query(`UPDATE order_details SET production_status_id=22 WHERE detail_id=11;
      INSERT INTO order_details VALUES (13,1,NULL,false,now()),(14,1,NULL,false,now())`);
    const batch = pinnedInput(true);
    batch.events[0].scope.details.push({ detailId: 11, requiredQuantity: 1, eligibleQuantity: 1 },
      { detailId: 13, requiredQuantity: 10, eligibleQuantity: 9 });
    await executePinnedMdfAutomation(tx, batch);
    expect((await client.query('SELECT detail_id,production_status_id FROM order_details ORDER BY detail_id')).rows)
      .toEqual([{ detail_id: '11', production_status_id: 22 }, { detail_id: '12', production_status_id: 7 },
        { detail_id: '13', production_status_id: null }, { detail_id: '14', production_status_id: null }]);
    expect((await client.query('SELECT order_status_id FROM orders')).rows[0].order_status_id).toBe(4);
    const audit = (await client.query("SELECT metadata_json FROM audit_log WHERE event='orders.detail_production_status_batch_change'")).rows[0];
    expect(audit.metadata_json.changedDetailIds).toEqual([12]);
    expect((await client.query('SELECT payload_json FROM outbox_events')).rows)
      .toEqual([expect.objectContaining({ payload_json: expect.objectContaining({ changedDetailIds: [12], actorUserId: '1' }) })]);
    expect((await client.query('SELECT production_status_id FROM order_hdf_details')).rows[0].production_status_id).toBeNull();
  }));

  it.each([false, true])('real nested composition honors pins (downstream=%s)', async downstream => fixture(async (client, tx) => {
    await addMdfRule(client);
    await executePinnedMdfAutomation(tx, pinnedInput(downstream));
    expect((await client.query('SELECT order_status_id FROM orders')).rows[0].order_status_id).toBe(downstream ? 6 : 4);
    expect((await client.query('SELECT production_status_id FROM order_details ORDER BY detail_id')).rows.map(r => r.production_status_id)).toEqual([7, 7]);
    expect((await client.query('SELECT count(*)::int AS n FROM outbox_events')).rows[0].n).toBe(downstream ? 2 : 1);
    expect((await client.query("SELECT entity_id FROM audit_log WHERE event='status_automation.rule_applied' ORDER BY entity_id")).rows)
      .toEqual((downstream ? ['910001', '910003'] : ['910003']).map(entity_id => ({ entity_id })));
  }));

  it('savepoint rollback restores DB effects and allows the same batch to execute again', async () => fixture(async (client, tx) => {
    await addMdfRule(client); const batch = pinnedInput(true);
    await client.query('SAVEPOINT e2e_pinned');
    await executePinnedMdfAutomation(tx, batch);
    await client.query('ROLLBACK TO SAVEPOINT e2e_pinned');
    expect((await client.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n).toBe(0);
    expect((await client.query('SELECT count(*)::int AS n FROM outbox_events')).rows[0].n).toBe(0);
    expect((await client.query('SELECT production_status_id FROM order_details WHERE detail_id=12')).rows[0].production_status_id).toBeNull();
    await executePinnedMdfAutomation(tx, batch);
    expect((await client.query('SELECT order_status_id FROM orders')).rows[0].order_status_id).toBe(6);
    expect((await client.query('SELECT count(*)::int AS n FROM outbox_events')).rows[0].n).toBe(2);
    await executePinnedMdfAutomation(tx, batch);
    expect((await client.query('SELECT count(*)::int AS n FROM outbox_events')).rows[0].n).toBe(2);
  }));

  it.each(['changed', 'disabled', 'missing'])('persists %s pin skip, without detail or outbox writes', async cause => fixture(async (client, tx) => {
    await addMdfRule(client);
    if (cause === 'changed') await client.query('UPDATE status_automation_rules SET version=2 WHERE id=910003');
    if (cause === 'disabled') await client.query('UPDATE status_automation_rules SET is_enabled=false WHERE id=910003');
    if (cause === 'missing') await client.query('DELETE FROM status_automation_rules WHERE id=910003');
    await executePinnedMdfAutomation(tx, pinnedInput());
    expect((await client.query('SELECT production_status_id FROM order_details WHERE detail_id=12')).rows[0].production_status_id).toBeNull();
    const audit = (await client.query("SELECT entity_id,user_id,metadata_json FROM audit_log WHERE event='status_automation.rule_skipped'")).rows[0];
    expect(audit).toMatchObject({ entity_id: '910003', user_id: '1', metadata_json: {
      reason: `pinned_rule_${cause === 'changed' ? 'version_changed' : cause}`, expectedRuleVersion: 1,
    } });
    expect((await client.query('SELECT count(*)::int AS n FROM audit_log_related_entity')).rows[0].n).toBe(1);
    expect((await client.query('SELECT count(*)::int AS n FROM outbox_events')).rows[0].n).toBe(0);
  }));

  it('locks pinned definitions against edits until transaction end', async () => {
    const client = await pool.connect(), other = await pool.connect();
    const schema = `e2e_mdf_pins_lock_${randomUUID().replaceAll('-', '')}`;
    try {
      await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},public;
        CREATE TABLE status_automation_rules (LIKE public.status_automation_rules INCLUDING ALL)`);
      await addMdfRule(client);
      await client.query('BEGIN');
      const tx = { raw: client, query: (sql: string, params: readonly unknown[] = []) => client.query(sql, [...params]) } as TransactionClient;
      expect((await loadRulesForPinnedExecution(tx, [910003]))[0].version).toBe(1);
      await other.query(`SET search_path TO ${schema},public; SET lock_timeout='100ms'`);
      await expect(other.query('UPDATE status_automation_rules SET version=2 WHERE id=910003')).rejects.toMatchObject({ code: '55P03' });
      await client.query('COMMIT');
      await other.query('UPDATE status_automation_rules SET version=2 WHERE id=910003');
      expect((await loadRulesForPinnedExecution(tx, [910003]))[0].version).toBe(2);
    } finally {
      await client.query(`ROLLBACK; SET search_path TO public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await other.query('RESET search_path; RESET lock_timeout');
      expect((await client.query('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].n).toBe(0);
      client.release(); other.release();
    }
  });

  it('rejects one unassigned detail despite a corrupted matching header', async () => fixture(async (client, tx) => {
    await client.query("SET LOCAL session_replication_role=replica; UPDATE orders SET production_status_id=7; SET LOCAL session_replication_role=origin");
    await evaluateProductionCompositionAutomation(tx, input());
    expect((await client.query('SELECT order_status_id FROM orders')).rows[0].order_status_id).toBe(4);
    const audit = (await client.query("SELECT metadata_json FROM audit_log WHERE event='status_automation.rule_skipped'")).rows[0];
    expect(audit.metadata_json.productionSummary).toEqual({ detailCount: 2, unassignedCount: 1, statusIds: [7] });
    expect((await client.query('SELECT count(*)::int AS n FROM outbox_events')).rows[0].n).toBe(0);
  }));

  it('updates the order only when all ordinary details match; HDF excluded and reverse echo suppressed', async () => fixture(async (client, tx) => {
    await client.query('UPDATE order_details SET production_status_id=7 WHERE detail_id=12');
    await evaluateProductionCompositionAutomation(tx, input());
    expect((await client.query('SELECT order_status_id,version FROM orders')).rows[0]).toEqual({ order_status_id: 6, version: 2 });
    expect((await client.query('SELECT production_status_id FROM order_details')).rows.map(r => r.production_status_id)).toEqual([7, 7]);
    expect((await client.query('SELECT production_status_id FROM order_hdf_details')).rows[0].production_status_id).toBeNull();
    const audit = (await client.query("SELECT metadata_json FROM audit_log WHERE event='status_automation.rule_applied'")).rows[0];
    expect(audit.metadata_json).toMatchObject({ cause: 'derived_from_production_composition',
      productionSummary: { detailCount: 2, unassignedCount: 0, statusIds: [7] } });
    expect((await client.query('SELECT event_type FROM outbox_events')).rows).toEqual([{ event_type: 'order.status_changed' }]);
    expect((await client.query('SELECT payload_json FROM outbox_events')).rows[0].payload_json.cause).toBe('derived_from_production_composition');
  }));

  it('rejects mixed alternatives, empty composition, and terminal order protection', async () => fixture(async (client, tx) => {
    await client.query(`UPDATE status_automation_rules SET conditions_json='{"currentProductionStatusIn":[6,7],"currentOrderStatusNotIn":[8]}' WHERE id=910001;
      UPDATE order_details SET production_status_id=6 WHERE detail_id=12;`);
    await evaluateProductionCompositionAutomation(tx, input());
    expect((await client.query('SELECT order_status_id FROM orders')).rows[0].order_status_id).toBe(4);
    await client.query('UPDATE order_details SET delete_flag=true');
    await evaluateProductionCompositionAutomation(tx, input());
    expect((await client.query('SELECT order_status_id FROM orders')).rows[0].order_status_id).toBe(4);
    await client.query('UPDATE order_details SET delete_flag=false,production_status_id=7; UPDATE orders SET order_status_id=8');
    await evaluateProductionCompositionAutomation(tx, input());
    expect((await client.query('SELECT order_status_id FROM orders')).rows[0].order_status_id).toBe(8);
  }));
});

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

// Explicit test-only target. Every schema/function/fixture is rolled back, also
// on assertion failure when psql closes the connection. Never touch public data.
const integration = process.env.PRODUCTION_SUMMARY_DOCKER_TEST === 'true' ? describe : describe.skip;
const migration = readFileSync(new URL('./155_order_production_composition.sql', import.meta.url), 'utf8')
  .replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');

function probe(assertions: string) {
  const schema = `e2e_production_summary_${randomUUID().replaceAll('-', '')}`;
  const sql = `BEGIN;
    CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}, public;
    CREATE TABLE orders (order_id bigint PRIMARY KEY, order_name text,
      production_status_id smallint, updated_at timestamptz DEFAULT now());
    CREATE TABLE production_statuses (production_status_id smallint PRIMARY KEY, sort_order integer);
    CREATE TABLE order_details (detail_id bigint PRIMARY KEY, order_id bigint,
      production_status_id smallint, delete_flag boolean DEFAULT false, updated_at timestamptz);
    CREATE TABLE order_hdf_details (hdf_detail_id bigint, order_id bigint, production_status_id smallint);
    CREATE VIEW orders_view AS SELECT order_id, order_name FROM orders;
    CREATE VIEW payments_view AS SELECT 1 AS payment_id, order_id FROM orders;
    INSERT INTO production_statuses VALUES (1,10),(2,20),(3,30);
    INSERT INTO orders VALUES (1,'E2E-Тест состав',3,now()),(2,'E2E-Тест перенос',3,now());
    INSERT INTO order_details VALUES (11,1,2,false,now()),(12,1,NULL,false,now());
    INSERT INTO order_hdf_details VALUES (1,1,NULL);
    ${migration}
    ${assertions}
    ROLLBACK;`;
  const output = execFileSync('docker', ['exec', '-i', 'erp_test-postgresdb-1', 'psql',
    '-X', '-U', 'postgres', '-d', 'erpdb', '-v', 'ON_ERROR_STOP=1', '-q'],
  { input: sql, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  expect(output).not.toContain('ERROR');
}

function check(expression: string) {
  return `DO $$ BEGIN IF NOT (${expression}) THEN RAISE EXCEPTION 'E2E composition assertion failed'; END IF; END $$;`;
}

integration('production summary migration (real PostgreSQL, rollback-only fixtures)', () => {
  it('backfills missing and empty without overwriting details', () => probe(`
    ${check('(SELECT production_status_id IS NULL AND production_detail_count=2 AND production_unassigned_count=1 AND production_distinct_status_count=1 FROM orders WHERE order_id=1)')}
    ${check('(SELECT production_status_id IS NULL AND production_detail_count=0 FROM orders WHERE order_id=2)')}
    ${check('(SELECT production_status_id=2 FROM order_details WHERE detail_id=11)')}
    ${check('(SELECT production_status_id IS NULL FROM order_details WHERE detail_id=12)')}
  `));

  it('tracks uniform, mixed and all-null; HDF does not block', () => probe(`
    UPDATE order_details SET production_status_id=2 WHERE detail_id=12;
    ${check('(SELECT production_status_id=2 AND production_unassigned_count=0 AND production_distinct_status_count=1 FROM orders WHERE order_id=1)')}
    UPDATE order_details SET production_status_id=3 WHERE detail_id=12;
    ${check('(SELECT production_status_id=2 AND production_distinct_status_count=2 FROM orders WHERE order_id=1)')}
    UPDATE order_details SET production_status_id=NULL WHERE order_id=1;
    ${check('(SELECT production_status_id IS NULL AND production_unassigned_count=2 AND production_distinct_status_count=0 FROM orders WHERE order_id=1)')}
  `));

  it('recalculates soft delete, restore, membership moves and hard delete', () => probe(`
    UPDATE order_details SET delete_flag=true WHERE detail_id=12;
    ${check('(SELECT production_status_id=2 AND production_detail_count=1 FROM orders WHERE order_id=1)')}
    UPDATE order_details SET delete_flag=false WHERE detail_id=12;
    ${check('(SELECT production_status_id IS NULL AND production_detail_count=2 FROM orders WHERE order_id=1)')}
    UPDATE order_details SET order_id=2 WHERE detail_id=12;
    ${check('(SELECT production_status_id=2 AND production_detail_count=1 FROM orders WHERE order_id=1)')}
    ${check('(SELECT production_status_id IS NULL AND production_unassigned_count=1 FROM orders WHERE order_id=2)')}
    DELETE FROM order_details WHERE detail_id=11;
    ${check('(SELECT production_status_id IS NULL AND production_detail_count=0 FROM orders WHERE order_id=1)')}
  `));

  it('supports explicit header cascade without lying for an empty order', () => probe(`
    UPDATE orders SET production_status_id=3 WHERE order_id IN (1,2);
    ${check('(SELECT production_status_id=3 AND production_unassigned_count=0 AND production_distinct_status_count=1 FROM orders WHERE order_id=1)')}
    ${check('(SELECT bool_and(production_status_id=3) FROM order_details WHERE order_id=1)')}
    ${check('(SELECT production_status_id IS NULL FROM orders WHERE order_id=2)')}
  `));

  it('fresh scoped composition does not trust the persisted summary', () => probe(`
    SET LOCAL session_replication_role=replica;
    UPDATE orders SET production_status_id=3 WHERE order_id=1;
    SET LOCAL session_replication_role=origin;
    ${check('(SELECT detail_count=2 AND unassigned_count=1 AND status_ids=ARRAY[2] FROM order_production_summary(1))')}
    ${check('(SELECT detail_count=1 AND unassigned_count=0 AND least_status_id=2 FROM order_production_summary(1,ARRAY[11]::bigint[]))')}
    ${check('(SELECT detail_count=0 AND least_status_id IS NULL FROM order_production_summary(1,ARRAY[]::bigint[]))')}
  `));

  it('can reapply migration and exposes compact counts in orders_view', () => probe(`
    ${migration}
    ${check('(SELECT production_detail_count=2 AND production_unassigned_count=1 FROM orders_view WHERE order_id=1)')}
    ${check('(SELECT production_detail_count=2 AND production_unassigned_count=1 FROM payments_view WHERE order_id=1)')}
  `));
});

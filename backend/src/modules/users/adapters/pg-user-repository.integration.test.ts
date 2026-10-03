import { randomUUID } from 'node:crypto';
import { Pool, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgUserRepository } from './pg-user-repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const admin: CurrentUser = { id: '1', username: 'admin', role: 'admin', roleId: 1, permissions: ['users.update'] };

describe.skipIf(!databaseUrl)('PgUserRepository relink audit (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_user_relink_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  // A transaction marked here stops right before its audit insert until the gate opens.
  let gate: { tag: string; open: Promise<void> } | null = null;

  const database = (tag: string) => ({
    isConfigured: true,
    query: <T extends QueryResultRow>(text: string, params: readonly unknown[] = []) => pool.query<T>(text, [...params]),
    transaction: async <T>(handler: (tx: unknown) => Promise<T>) => {
      const connection = await pool.connect();
      try {
        await connection.query(`SET search_path="${schema}",public`);
        await connection.query('BEGIN');
        try {
          const value = await handler({
            query: async <R extends QueryResultRow>(text: string, params: readonly unknown[] = []) => {
              if (gate?.tag === tag && /INSERT INTO audit_log\b/.test(text)) await gate.open;
              return connection.query<R>(text, [...params]);
            },
          });
          await connection.query('COMMIT');
          return value;
        } catch (error) {
          await connection.query('ROLLBACK');
          throw error;
        }
      } finally {
        connection.release();
      }
    },
  }) as unknown as DatabaseService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    pool.on('connect', (connection) => { void connection.query(`SET search_path="${schema}",public`); });
    await pool.query(`CREATE SCHEMA "${schema}"; SET search_path="${schema}",public;
      CREATE TABLE "${schema}".roles(role_id int PRIMARY KEY, role_code text);
      INSERT INTO "${schema}".roles VALUES (1, 'admin'), (10, 'manager');
      CREATE TABLE "${schema}".users(user_id bigint PRIMARY KEY, username text, email text, full_name text, role_id int, employee_id bigint,
        is_active boolean DEFAULT true, is_service_account boolean DEFAULT false, edited_by bigint,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      INSERT INTO "${schema}".users(user_id, username, role_id, employee_id) VALUES (15, 'relinked', 10, 101);
      CREATE TABLE "${schema}".audit_log(audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event text NOT NULL,entity_type text,entity_id text,
        user_id bigint,username text,role_code text,role text,request_id text NOT NULL,source text,related_order_id bigint,related_client_id bigint,
        related_payment_id bigint,related_production_event_id bigint,related_deadline_id bigint,related_user_id bigint,status_field text,
        status_id bigint,status_name text,status_code text,stage_code text,before_json jsonb,after_json jsonb,diff_json jsonb,metadata_json jsonb,
        created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE "${schema}".audit_log_related_entity(audit_id uuid NOT NULL,entity_type text NOT NULL,entity_id bigint NOT NULL,
        PRIMARY KEY(audit_id,entity_type,entity_id));`);
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool?.end();
  });

  it('concurrent relinks A → B → C: the second audits B → C, never A → C', async () => {
    let release!: () => void;
    gate = { tag: 'first', open: new Promise<void>((resolve) => { release = resolve; }) };
    const first = new PgUserRepository(database('first')).updateUser({ currentUser: admin, userId: 15, requestId: 'req-b', dto: { employeeId: 102 } });
    // The first command has updated the row and waits before its audit; the second must wait for its lock.
    for (let i = 0; i < 100 && !(await pool.query(`SELECT 1 FROM pg_stat_activity WHERE query LIKE '%INSERT INTO audit_log%' OR state = 'idle in transaction'`)).rowCount; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const second = new PgUserRepository(database('second')).updateUser({ currentUser: admin, userId: 15, requestId: 'req-c', dto: { employeeId: 103 } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await Promise.all([first, second]);
    gate = null;
    const links = (await pool.query(`SELECT a.request_id, array_agg(r.entity_id ORDER BY r.entity_id)::text links FROM "${schema}".audit_log a
      JOIN "${schema}".audit_log_related_entity r ON r.audit_id = a.audit_id GROUP BY a.request_id ORDER BY a.request_id`)).rows;
    expect(links).toEqual([{ request_id: 'req-b', links: '{101,102}' }, { request_id: 'req-c', links: '{102,103}' }]);
  });
});

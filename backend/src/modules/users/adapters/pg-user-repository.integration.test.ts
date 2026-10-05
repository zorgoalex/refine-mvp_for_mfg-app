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

describe.skipIf(!databaseUrl)('PgUserRepository target-role precondition (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_user_role_guard_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;

  const database = {
    isConfigured: true,
    query: <T extends QueryResultRow>(text: string, params: readonly unknown[] = []) => pool.query<T>(text, [...params]),
    transaction: async <T>(handler: (tx: unknown) => Promise<T>) => {
      const connection = await pool.connect();
      try {
        await connection.query(`SET search_path="${schema}",public`);
        await connection.query('BEGIN');
        try {
          const value = await handler({ query: <R extends QueryResultRow>(text: string, params: readonly unknown[] = []) => connection.query<R>(text, [...params]) });
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
  } as unknown as DatabaseService;
  const repository = () => new PgUserRepository(database);
  const state = async (userId: number) => (await pool.query<{ role_id: number; password_hash: string; is_active: boolean }>(
    `SELECT role_id, password_hash, is_active FROM "${schema}".users WHERE user_id = $1`, [userId])).rows[0];
  const audits = async () => Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM "${schema}".audit_log`)).rows[0].n);

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    pool.on('connect', (connection) => { void connection.query(`SET search_path="${schema}",public`); });
    await pool.query(`CREATE SCHEMA "${schema}"; SET search_path="${schema}",public;
      CREATE TABLE "${schema}".roles(role_id int PRIMARY KEY, role_code text);
      INSERT INTO "${schema}".roles VALUES (1, 'admin'), (10, 'manager'), (100, 'viewer');
      CREATE TABLE "${schema}".users(user_id bigint PRIMARY KEY, username text, email text, full_name text, password_hash text, role_id int,
        employee_id bigint, is_active boolean DEFAULT true, is_service_account boolean DEFAULT false, edited_by bigint,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      INSERT INTO "${schema}".users(user_id, username, password_hash, role_id) VALUES (21, 'sequential', 'old-hash', 100), (22, 'concurrent', 'old-hash', 100), (23, 'steady', 'old-hash', 100);
      CREATE TABLE "${schema}".auth_sessions(session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id bigint, status text, revoked_at timestamptz, revoke_reason text);
      CREATE TABLE "${schema}".refresh_tokens(token_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id bigint, revoked_at timestamptz, revoked_reason text);
      INSERT INTO "${schema}".auth_sessions(user_id, status) VALUES (21, 'active'), (22, 'active');
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

  const changePassword = (userId: number) => repository().changePassword({
    currentUser: { ...admin, permissions: ['users.change_password'] },
    userId,
    expectedTargetRole: 'viewer', // the role the access policy decided on
    requestId: 'req_role_guard',
    dto: { newPassword: 'new-secure-password', revokeExistingSessions: true },
  });

  it('a promotion committed after the policy check: the password change answers 409 and changes nothing', async () => {
    await pool.query(`UPDATE "${schema}".users SET role_id = 10 WHERE user_id = 21`);
    await expect(changePassword(21)).rejects.toMatchObject({ statusCode: 409, code: 'USER_ROLE_CHANGED' });
    expect(await state(21)).toMatchObject({ role_id: 10, password_hash: 'old-hash' });
    expect((await pool.query(`SELECT status FROM "${schema}".auth_sessions WHERE user_id = 21`)).rows[0].status).toBe('active');
    expect(await audits()).toBe(0);
  });

  it('a promotion still in flight: the password change waits for it and is then refused', async () => {
    const promoter = await pool.connect();
    try {
      await promoter.query(`SET search_path="${schema}",public`);
      await promoter.query('BEGIN');
      await promoter.query(`UPDATE "${schema}".users SET role_id = 10 WHERE user_id = 22`);
      const pending = changePassword(22).then((value) => ({ value }), (error: unknown) => ({ error }));
      // The UPDATE of the password change is blocked on the row the promoter holds.
      let blocked = false;
      for (let i = 0; i < 80 && !blocked; i += 1) {
        const waiting = await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%SET password_hash%' AND query NOT LIKE '%pg_stat_activity%'`);
        blocked = waiting.rowCount === 1;
        if (!blocked) await new Promise((done) => setTimeout(done, 100));
      }
      expect(blocked).toBe(true);
      await promoter.query('COMMIT');
      const outcome = await pending;
      expect(outcome).toMatchObject({ error: { statusCode: 409, code: 'USER_ROLE_CHANGED' } });
    } finally {
      await promoter.query('ROLLBACK').catch(() => undefined);
      promoter.release();
    }
    expect(await state(22)).toMatchObject({ role_id: 10, password_hash: 'old-hash' });
    expect((await pool.query(`SELECT status FROM "${schema}".auth_sessions WHERE user_id = 22`)).rows[0].status).toBe('active');
    expect(await audits()).toBe(0);
  });

  it('an unchanged role: the mutations apply and are audited; deactivation carries the same precondition', async () => {
    await expect(changePassword(23)).resolves.toMatchObject({ success: true });
    const changed = await state(23);
    expect(changed.password_hash).not.toBe('old-hash');
    expect(await audits()).toBe(1);

    await pool.query(`UPDATE "${schema}".users SET role_id = 10 WHERE user_id = 23`);
    await expect(
      repository().deactivateUser({ currentUser: { ...admin, permissions: ['users.deactivate'] }, userId: 23, expectedTargetRole: 'viewer' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'USER_ROLE_CHANGED' });
    expect(await state(23)).toMatchObject({ is_active: true, role_id: 10 });
    await expect(
      repository().updateUser({ currentUser: admin, userId: 23, expectedTargetRole: 'viewer', dto: { fullName: 'Stale' } }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'USER_ROLE_CHANGED' });
    expect(await audits()).toBe(1);
    await expect(
      repository().deactivateUser({ currentUser: { ...admin, permissions: ['users.deactivate'] }, userId: 23, expectedTargetRole: 'manager' }),
    ).resolves.toMatchObject({ isActive: false });
    expect(await audits()).toBe(2);
  });
});

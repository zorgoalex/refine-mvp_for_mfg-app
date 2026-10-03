import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../../permissions/current-user';
import { maskContact, normalizeContact, prepareContacts } from './employee-contacts';
import { EmployeeContactsRepository } from './employee-contacts.repository';
import { PgUserRepository } from '../users/adapters/pg-user-repository';

const databaseUrl = process.env.WHATSAPP_BROADCAST_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const admin: CurrentUser = { id: '11', username: 'contacts-admin', role: 'admin', roleId: 1, permissions: ['employees.view', 'employees.manage'] };

describe('employee work contacts — normalization', () => {
  it('normalizes phones, emails and Telegram accounts; refuses the rest', () => {
    expect(normalizeContact('phone', '8 701 555 01 01')).toBe('77015550101');
    expect(normalizeContact('email', ' Ivanov@Mebel.KZ ')).toBe('ivanov@mebel.kz');
    expect(normalizeContact('telegram', '@Ivan_Master')).toBe('ivan_master');
    expect(normalizeContact('telegram', 'https://t.me/ivan_master')).toBe('ivan_master');
    for (const [kind, value] of [['phone', '12345'], ['email', 'ivanov'], ['telegram', '@iv']] as const) {
      expect(() => normalizeContact(kind, value)).toThrowError(expect.objectContaining({ code: 'EMPLOYEE_CONTACT_INVALID' }));
    }
    expect(maskContact('phone', '77015550101')).toBe('7701***0101');
    expect(maskContact('email', 'ivanov@mebel.kz')).toBe('iv***@mebel.kz');
    expect(maskContact('telegram', 'ivan_master')).toBe('@iv***');
  });

  it('one primary per kind (the first one by default), no duplicate value of a kind', () => {
    const prepared = prepareContacts([
      { contactId: null, kind: 'phone', value: '87015550101', isPrimary: false, note: null },
      { contactId: null, kind: 'phone', value: '87015550102', isPrimary: false, note: ' ' },
      { contactId: null, kind: 'email', value: 'a@b.kz', isPrimary: true, note: 'рабочий' },
    ]);
    expect(prepared.map((contact) => contact.isPrimary)).toEqual([true, false, true]);
    expect(prepared[1].note).toBeNull();
    expect(() => prepareContacts([
      { contactId: null, kind: 'phone', value: '87015550101', isPrimary: false, note: null },
      { contactId: null, kind: 'phone', value: '+7 701 555 01 01', isPrimary: false, note: null },
    ])).toThrowError(expect.objectContaining({ code: 'EMPLOYEE_CONTACT_DUPLICATE' }));
    expect(() => prepareContacts([
      { contactId: null, kind: 'phone', value: '87015550101', isPrimary: true, note: null },
      { contactId: null, kind: 'phone', value: '87015550102', isPrimary: true, note: null },
    ])).toThrowError(expect.objectContaining({ code: 'EMPLOYEE_CONTACT_INVALID' }));
  });
});

describe.skipIf(!databaseUrl)('employee work contacts (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_employee_contacts_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  let repository: EmployeeContactsRepository;
  let database: DatabaseService;
  // A command stopped right before its audit insert until the gate opens (concurrency tests).
  let gate: Promise<void> | null = null;
  const q = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => client.query<T>(text, params);
  const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof ApiError ? error.code : String(error)));

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    pool.on('connect', (connection) => { void connection.query(`SET search_path="${schema}",public`); });
    client = await pool.connect();
    await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await q(`SET search_path="${schema}",public`);
    await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await q(`CREATE TABLE audit_log(audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event text NOT NULL,entity_type text,entity_id text,user_id bigint,
      username text,role_code text,role text,request_id text NOT NULL,source text,related_order_id bigint,related_client_id bigint,related_payment_id bigint,
      related_production_event_id bigint,related_deadline_id bigint,related_user_id bigint,status_field text,status_id bigint,status_name text,status_code text,
      stage_code text,before_json jsonb,after_json jsonb,diff_json jsonb,metadata_json jsonb,created_at timestamptz DEFAULT now());
      CREATE TABLE audit_log_related_entity(audit_id uuid NOT NULL,entity_type text NOT NULL,entity_id bigint NOT NULL,PRIMARY KEY(audit_id,entity_type,entity_id));
      CREATE TABLE orders(order_id bigint PRIMARY KEY);
      CREATE TABLE employees(employee_id bigint PRIMARY KEY, full_name text NOT NULL, is_active boolean NOT NULL DEFAULT true);
      INSERT INTO employees(employee_id, full_name) VALUES (1, 'Тест Сотрудник Один'), (2, 'Тест Сотрудник Два');
      CREATE TABLE roles(role_id int PRIMARY KEY, role_code text);
      INSERT INTO roles VALUES (1, 'admin');
      CREATE TABLE users(user_id bigint PRIMARY KEY, username text, email text, full_name text, role_id int REFERENCES roles,
        employee_id bigint REFERENCES employees(employee_id), is_active boolean DEFAULT true, is_service_account boolean DEFAULT false,
        edited_by bigint, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      INSERT INTO users(user_id, username, role_id) VALUES (11, 'contacts-admin', 1), (12, 'other-admin', 1);
      -- The real audit FK (migration 001): an audit row key-shares its actor.
      ALTER TABLE audit_log ADD CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL;`);
    for (const file of ['230_whatsapp_order_send.sql', '233_whatsapp_order_send_queue.sql', '235_employee_work_contacts.sql']) {
      await q(await readFile(new URL(`../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    database = {
      isConfigured: true,
      query: <T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => pool.query<T>(text, [...params]),
      transaction: async <T>(handler: (tx: unknown) => Promise<T>) => {
        const connection = await pool.connect();
        try {
          await connection.query(`SET search_path="${schema}",public`);
          await connection.query('BEGIN');
          try {
            const value = await handler({ query: async <R extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => {
              if (gate && /INSERT INTO audit_log\b/.test(text)) await gate;
              return connection.query<R>(text, [...params]);
            } });
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
    repository = new EmployeeContactsRepository(database);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      try { await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { client.release(); }
    }
    await pool?.end();
  });

  beforeEach(async () => {
    await q('DELETE FROM employee_work_contacts');
    await q('UPDATE employees SET work_contacts_version = 0');
  });

  it('replaces the set under the version; contacts keep their ids; a stale version is a conflict', async () => {
    const first = await repository.replace(1, 0, [
      { contactId: null, kind: 'phone', value: '8 701 555 01 01', isPrimary: false, note: null },
      { contactId: null, kind: 'email', value: 'Master@Mebel.kz', isPrimary: false, note: 'рабочая почта Иванова' },
    ], admin, 'req-1');
    expect(first.version).toBe(1);
    expect(first.contacts.map((contact) => [contact.kind, contact.valueNormalized, contact.isPrimary])).toEqual([
      ['email', 'master@mebel.kz', true], ['phone', '77015550101', true]]);
    const phone = first.contacts.find((contact) => contact.kind === 'phone')!;
    const email = first.contacts.find((contact) => contact.kind === 'email')!;
    // Changing the email keeps the phone row (a waiting send that used it stays valid); a new phone becomes primary on request.
    const second = await repository.replace(1, 1, [
      { contactId: phone.contactId, kind: 'phone', value: phone.value, isPrimary: false, note: null },
      { contactId: null, kind: 'phone', value: '87015550102', isPrimary: true, note: null },
      { contactId: email.contactId, kind: 'email', value: 'other@mebel.kz', isPrimary: true, note: null },
    ], admin, 'req-2');
    expect(second.version).toBe(2);
    expect(second.contacts.find((contact) => contact.contactId === phone.contactId)).toMatchObject({ isPrimary: false, valueNormalized: '77015550101' });
    expect(second.contacts.find((contact) => contact.valueNormalized === '77015550102')?.isPrimary).toBe(true);
    expect(await code(repository.replace(1, 1, [], admin, 'req-stale'))).toBe('EMPLOYEE_CONTACTS_VERSION_CONFLICT');
    // Removing the last contacts works on an empty set too.
    const empty = await repository.replace(1, 2, [], admin, 'req-3');
    expect(empty).toMatchObject({ version: 3, contacts: [] });
    expect(await code(repository.replace(1, 2, [], admin, 'req-stale-empty'))).toBe('EMPLOYEE_CONTACTS_VERSION_CONFLICT');
  });

  it('swaps values and primaries between contacts keeping their ids', async () => {
    const first = await repository.replace(1, 0, [
      { contactId: null, kind: 'phone', value: '87015550101', isPrimary: true, note: null },
      { contactId: null, kind: 'phone', value: '87015550102', isPrimary: false, note: 'второй' },
    ], admin, 'req-swap-1');
    const [a, b] = first.contacts;
    const swapped = await repository.replace(1, 1, [
      { contactId: a.contactId, kind: 'phone', value: b.value, isPrimary: false, note: null },
      { contactId: b.contactId, kind: 'phone', value: a.value, isPrimary: true, note: 'второй' },
    ], admin, 'req-swap-2');
    expect(swapped.version).toBe(2);
    expect(Object.fromEntries(swapped.contacts.map((contact) => [contact.contactId, [contact.valueNormalized, contact.isPrimary]]))).toEqual({
      [a.contactId]: [b.valueNormalized, false], [b.contactId]: [a.valueNormalized, true] });
  });

  it('a contact id twice in one set is refused: set, version and audit stay', async () => {
    const first = await repository.replace(1, 0, [{ contactId: null, kind: 'phone', value: '87015550101', isPrimary: true, note: null }], admin, 'req-dup-1');
    const id = first.contacts[0].contactId;
    expect(await code(repository.replace(1, 1, [
      { contactId: id, kind: 'phone', value: '87015550101', isPrimary: true, note: null },
      { contactId: id, kind: 'phone', value: '87015550109', isPrimary: false, note: null },
    ], admin, 'req-dup-2'))).toBe('EMPLOYEE_CONTACT_INVALID');
    expect(await repository.get(1)).toMatchObject({ version: 1, contacts: [{ contactId: id, valueNormalized: '77015550101', isPrimary: true }] });
    expect((await q(`SELECT count(*)::int n FROM audit_log WHERE request_id = 'req-dup-2'`)).rows[0].n).toBe(0);
  });

  it('a contacts save by a user and his relink to that employee at once never deadlock', async () => {
    const other: CurrentUser = { ...admin, id: '12', username: 'other-admin' };
    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    // User 11 saves employee 1's contacts and stops before the audit (employee row locked, actor key-share next).
    const save = repository.replace(1, 0, [{ contactId: null, kind: 'phone', value: '87015550101', isPrimary: true, note: null }], admin, 'req-lock-save');
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Another admin links user 11 to employee 1: locks the user row, the FK key-shares employee 1. Its audit
    // passes the gate only after the save goes on, so both run into each other's rows here.
    const relink = new PgUserRepository(database).updateUser({ currentUser: other, userId: 11, requestId: 'req-lock-relink', dto: { employeeId: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    gate = null;
    release();
    const results = await Promise.allSettled([save, relink]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await q(`SELECT employee_id FROM users WHERE user_id = 11`)).rows[0].employee_id).toBe('1');
    expect((await repository.get(1)).version).toBe(1);
  });

  it('two editors of an empty set: one wins, the other gets a conflict', async () => {
    const results = await Promise.all([
      code(repository.replace(2, 0, [{ contactId: null, kind: 'phone', value: '87015550111', isPrimary: true, note: null }], admin, 'req-a')),
      code(repository.replace(2, 0, [{ contactId: null, kind: 'phone', value: '87015550112', isPrimary: true, note: null }], admin, 'req-b')),
    ]);
    expect(results.sort()).toEqual(['EMPLOYEE_CONTACTS_VERSION_CONFLICT', 'ok']);
    expect((await repository.get(2)).contacts).toHaveLength(1);
  });

  it('audits masks only (no value, no note text), linked to the employee', async () => {
    await repository.replace(1, 0, [
      { contactId: null, kind: 'phone', value: '87015550101', isPrimary: true, note: 'секретное примечание' },
      { contactId: null, kind: 'telegram', value: '@ivan_master', isPrimary: true, note: null },
    ], admin, 'req-audit');
    const audit = (await q(`SELECT a.*, r.entity_id related FROM audit_log a JOIN audit_log_related_entity r ON r.audit_id = a.audit_id
      WHERE a.event = 'employee.work_contacts.updated' AND a.request_id = 'req-audit'`)).rows[0];
    expect(audit).toMatchObject({ entity_type: 'employee', entity_id: '1', related: '1', user_id: '11', source: 'erp_employees' });
    const text = JSON.stringify(audit);
    expect(text).toContain('7701***0101');
    expect(text).not.toContain('77015550101');
    expect(text).not.toContain('ivan_master');
    expect(text).not.toContain('секретное');
  });

  it('an employee with contacts cannot be deleted directly (RESTRICT): contacts go only through the command', async () => {
    await repository.replace(2, 0, [{ contactId: null, kind: 'phone', value: '87015550121', isPrimary: true, note: null }], admin, 'req-restrict');
    expect(await code(q('DELETE FROM employees WHERE employee_id = 2'))).toContain('foreign key');
    expect((await repository.get(2)).contacts).toHaveLength(1);
    expect(await code(repository.get(404))).toBe('EMPLOYEE_NOT_FOUND');
    expect((await repository.listFor([1, 2])).get(2)?.map((contact) => contact.valueNormalized)).toEqual(['77015550121']);
  });
});

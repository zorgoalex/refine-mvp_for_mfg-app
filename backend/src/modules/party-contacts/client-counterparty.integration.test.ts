import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../../permissions/current-user';
import { ClientCounterpartyRepository } from './client-counterparty.repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const admin: CurrentUser = { id: '11', username: 'clients-admin', role: 'admin', roleId: 1, permissions: ['clients.update'] };
const REF = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe.skipIf(!databaseUrl)('the client ↔ 1C counterparty link (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_client_counterparty_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  let links: ClientCounterpartyRepository;
  const q = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => client.query<T>(text, params);
  const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof ApiError ? error.code : String(error)));
  const details = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error instanceof ApiError ? error.details : String(error)));
  const mirror = (ref: string, name: string, data: Record<string, unknown> = {}, row: { deleted?: boolean; missing?: boolean; source?: number } = {}) =>
    q(`INSERT INTO onec_etl_mirror_rows(source_id, entity_code, source_key, deleted, data, missing_in_source_at)
       VALUES ($1, 'counterparties', $2, $3, $4, CASE WHEN $5 THEN now() END)`,
    [row.source ?? 1, ref, row.deleted ?? false, JSON.stringify({ Ref_Key: ref, Description: name, 'Покупатель': true, ...data }), row.missing ?? false]);
  const phone = (ref: string, value: string, line = 1, row: { deleted?: boolean } = {}) =>
    q(`INSERT INTO onec_etl_mirror_rows(source_id, entity_code, source_key, deleted, data)
       VALUES (1, 'counterparty_phones', $1, $2, $3)`,
    [`${ref}:${line}`, row.deleted ?? false, JSON.stringify({ Ref_Key: ref, LineNumber: String(line), 'Тип': 'Телефон', 'Представление': value })]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    pool.on('connect', (connection) => { void connection.query(`SET search_path="${schema}",public`); });
    client = await pool.connect();
    await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await q(`SET search_path="${schema}",public`);
    // Extensions live in public: created inside a test schema they vanish with it (or hide in a leftover one).
    await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
      CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public`);
    // Owner tables with the real column types (citext client name, uuid 1C key with its unique index).
    await q(`CREATE TABLE users(user_id bigint PRIMARY KEY, username citext);
      INSERT INTO users VALUES (11, 'clients-admin');
      CREATE TABLE audit_log(audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event text NOT NULL,entity_type text,entity_id text,
        user_id bigint REFERENCES users(user_id) ON DELETE SET NULL,
        username text,role_code text,role text,request_id text NOT NULL,source text,related_order_id bigint,related_client_id bigint,related_payment_id bigint,
        related_production_event_id bigint,related_deadline_id bigint,related_user_id bigint,status_field text,status_id bigint,status_name text,status_code text,
        stage_code text,before_json jsonb,after_json jsonb,diff_json jsonb,metadata_json jsonb,created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE audit_log_related_entity(audit_id uuid NOT NULL,entity_type text NOT NULL,entity_id bigint NOT NULL,PRIMARY KEY(audit_id,entity_type,entity_id));
      CREATE TABLE clients(client_id bigint PRIMARY KEY, client_name citext NOT NULL UNIQUE, ref_key_1c uuid, edited_by bigint, notes text);
      CREATE UNIQUE INDEX idx_clients__ref_key_1c ON clients(ref_key_1c) WHERE ref_key_1c IS NOT NULL;
      CREATE TABLE client_phones(phone_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, client_id bigint NOT NULL, phone_number text NOT NULL);
      CREATE TABLE onec_etl_mirror_rows(source_id bigint, entity_code text, source_key text, deleted boolean NOT NULL DEFAULT false,
        data jsonb NOT NULL, missing_in_source_at timestamptz);
      INSERT INTO clients(client_id, client_name, notes) VALUES (1, 'Тест Айдын Адилов', 'заметка'), (2, 'ТОО «Тест Ромашка»', NULL), (3, 'Тест Третий', NULL);
      INSERT INTO client_phones(client_id, phone_number) VALUES (1, '+7 (701) 555-01-01'), (1, '8 777 123 45 67'), (3, '87015550909');`);
    const database = {
      isConfigured: true,
      query: <T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => pool.query<T>(text, [...params]),
      transaction: async <T>(handler: (tx: unknown) => Promise<T>) => {
        const connection = await pool.connect();
        try {
          await connection.query(`SET search_path="${schema}",public`);
          await connection.query('BEGIN');
          try {
            const value = await handler({ query: <R extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => connection.query<R>(text, [...params]) });
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
    links = new ClientCounterpartyRepository(database);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      try { await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { client.release(); }
    }
    await pool?.end();
  });

  beforeEach(async () => {
    await q(`DELETE FROM audit_log_related_entity; DELETE FROM audit_log; DELETE FROM onec_etl_mirror_rows; UPDATE clients SET ref_key_1c = NULL, edited_by = NULL`);
  });

  it('offers what looks like the client: equal name and phone first, then one of them, then a similar name; never folders or gone rows', async () => {
    await mirror(REF(1), 'Адилов Айдын Тест', { Code: 'НФ-001', 'ИдентификационныйНомер': '900101300123' });
    await phone(REF(1), '87015550101', 1);
    await phone(REF(1), '8 (727) 300-00-00', 2);
    await mirror(REF(2), 'тест айдын адилов');
    await mirror(REF(3), 'Совсем Другой');
    await phone(REF(3), '+7 777 123-45-67 доб. 5');
    await mirror(REF(4), 'Тест Айдын Адилов', { IsFolder: true });
    await mirror(REF(5), 'Тест Айдын Адилов', { DeletionMark: true });
    await mirror(REF(6), 'Тест Айдын Адилов', {}, { missing: true });
    await mirror(REF(7), 'Тест Айдын Адилов', {}, { deleted: true });
    await mirror(REF(8), 'Посторонний');
    await phone(REF(8), '87015550101', 1, { deleted: true });
    await mirror(REF(9), 'Короткий номер');
    await phone(REF(9), '5550101');
    await q(`UPDATE clients SET ref_key_1c = $1 WHERE client_id = 3`, [REF(3)]);

    const offered = await links.candidates(1, null);
    // One exact reason each; the one that also has a similar name goes first, the rest by name.
    expect(offered.map((item) => [item.refKey1c, item.matchedBy])).toEqual([
      [REF(1), ['phone', 'similar']],
      [REF(3), ['phone']],
      [REF(2), ['name']],
    ]);
    expect(offered.find((item) => item.refKey1c === REF(1))).toEqual({
      refKey1c: REF(1), name: 'Адилов Айдын Тест', code: 'НФ-001', bin: '900101300123', isBuyer: true,
      phones: ['8 (727) 300-00-00', '87015550101'], matchedBy: ['phone', 'similar'], clientId: null, clientName: null,
    });
    // A counterparty of another client is offered with its holder: the page shows it and does not let choose it.
    expect(offered.find((item) => item.refKey1c === REF(3))).toMatchObject({ clientId: 3, clientName: 'Тест Третий' });
    // The legal form and quotes do not matter for a name.
    await mirror(REF(10), 'Тест Ромашка ТОО');
    expect((await links.candidates(2, null)).map((item) => [item.refKey1c, item.matchedBy])).toEqual([[REF(10), ['name']]]);
    expect(await code(links.candidates(404, null))).toBe('CLIENT_NOT_FOUND');
  });

  it('searches by name, code, BIN and phone digits; a wildcard is a plain character', async () => {
    await mirror(REF(1), 'Тест Альфа', { Code: 'НФ-000777', 'ИдентификационныйНомер': '123456789012', 'Покупатель': false });
    await phone(REF(1), '+7 (701) 555-44-33');
    await mirror(REF(2), 'Тест Бета');
    const refs = async (text: string) => (await links.candidates(1, text)).map((item) => item.refKey1c);
    expect(await refs('альф')).toEqual([REF(1)]);
    expect(await refs('000777')).toEqual([REF(1)]);
    expect(await refs('123456789012')).toEqual([REF(1)]);
    expect(await refs('8 701 555 44 33')).toEqual([REF(1)]);
    expect(await refs('+7 701 555')).toEqual([REF(1)]);
    expect(await refs('8701555')).toEqual([REF(1)]);
    expect(await refs('тест')).toEqual([REF(2), REF(1)]);
    expect(await refs('100%_')).toEqual([]);
    expect((await links.candidates(1, 'альф'))[0]).toMatchObject({ isBuyer: false, matchedBy: [], phones: ['+7 (701) 555-44-33'] });
  });

  it('links by compare-and-swap: a repeat is silent; a stale, taken or unknown key is refused; every change is audited with the client', async () => {
    await mirror(REF(1), 'Тест Контрагент 1', { Code: 'К-1', 'ИдентификационныйНомер': '111111111111' });
    await mirror(REF(2), 'Тест Контрагент 2', { Code: 'К-2' });
    await phone(REF(1), '87015550101');
    const linked = await links.setLink(1, REF(1), null, admin, 'req-c1');
    expect(linked).toEqual({
      clientId: 1, clientName: 'Тест Айдын Адилов', refKey1c: REF(1), available: true,
      counterparty: { refKey1c: REF(1), name: 'Тест Контрагент 1', code: 'К-1', bin: '111111111111', isBuyer: true, phones: ['87015550101'] },
    });
    // The answer was lost and the command repeated: same state, no second audit.
    await links.setLink(1, REF(1), null, admin, 'req-c1-repeat');
    // A second editor still sees «not linked»: refused with the current key, nothing overwritten.
    expect(await code(links.setLink(1, REF(2), null, admin, 'req-stale'))).toBe('CLIENT_COUNTERPARTY_CONFLICT');
    expect(await details(links.setLink(1, null, REF(2), admin, 'req-stale2'))).toEqual({ refKey1c: REF(1) });
    // One counterparty — one client: the holder is named.
    expect(await code(links.setLink(3, REF(1), null, admin, 'req-taken'))).toBe('CLIENT_COUNTERPARTY_TAKEN');
    expect(await details(links.setLink(3, REF(1), null, admin, 'req-taken2'))).toEqual({ clientId: 1, clientName: 'Тест Айдын Адилов' });
    expect(await code(links.setLink(3, REF(9), null, admin, 'req-unknown'))).toBe('CLIENT_COUNTERPARTY_UNKNOWN');
    expect(await code(links.setLink(404, REF(2), null, admin, 'req-404'))).toBe('CLIENT_NOT_FOUND');
    const relinked = await links.setLink(1, REF(2), REF(1), admin, 'req-c2');
    expect(relinked.counterparty?.name).toBe('Тест Контрагент 2');
    // The counterparty is free again for another client.
    expect((await links.setLink(3, REF(1), null, admin, 'req-c3')).refKey1c).toBe(REF(1));
    expect(await links.setLink(1, null, REF(2), admin, 'req-c4')).toMatchObject({ refKey1c: null, counterparty: null });

    const audit = (await q(`SELECT a.event, a.entity_type, a.entity_id, a.request_id, a.source, a.related_client_id::text AS client, a.user_id::text AS actor,
        a.before_json->>'refKey1c' b, a.after_json->>'refKey1c' a, a.before_json->>'counterpartyName' bn, a.after_json->>'counterpartyName' an,
        a.metadata_json->>'counterpartyCode' code, r.entity_id::text AS related
      FROM audit_log a JOIN audit_log_related_entity r ON r.audit_id = a.audit_id AND r.entity_type = 'client' ORDER BY a.created_at`)).rows;
    const row = (event: string, requestId: string, id: string, b: string | null, a: string | null, bn: string | null, an: string | null, c: string) => ({
      event, entity_type: 'client', entity_id: id, request_id: requestId, source: 'erp_party_contacts', client: id, actor: '11', b, a, bn, an, code: c, related: id,
    });
    expect(audit).toEqual([
      row('client.counterparty_linked', 'req-c1', '1', null, REF(1), null, 'Тест Контрагент 1', 'К-1'),
      row('client.counterparty_linked', 'req-c2', '1', REF(1), REF(2), 'Тест Контрагент 1', 'Тест Контрагент 2', 'К-2'),
      row('client.counterparty_linked', 'req-c3', '3', null, REF(1), null, 'Тест Контрагент 1', 'К-1'),
      row('client.counterparty_unlinked', 'req-c4', '1', REF(2), null, 'Тест Контрагент 2', null, 'К-2'),
    ]);
    // Only the key and the editor of the client row change.
    expect((await q(`SELECT client_name::text AS name, notes, edited_by::text AS edited_by, ref_key_1c FROM clients WHERE client_id = 1`)).rows[0])
      .toEqual({ name: 'Тест Айдын Адилов', notes: 'заметка', edited_by: '11', ref_key_1c: null });
  });

  it('two clients taking one counterparty at once: exactly one gets it, the other is told who holds it', async () => {
    await mirror(REF(1), 'Тест Спорный');
    const results = await Promise.all([
      code(links.setLink(1, REF(1), null, admin, 'req-race-1')),
      code(links.setLink(2, REF(1), null, admin, 'req-race-2')),
      code(links.setLink(3, REF(1), null, admin, 'req-race-3')),
    ]);
    expect(results.filter((result) => result === 'ok')).toHaveLength(1);
    expect(results.filter((result) => result === 'CLIENT_COUNTERPARTY_TAKEN')).toHaveLength(2);
    expect((await q(`SELECT count(*)::int n FROM clients WHERE ref_key_1c = $1`, [REF(1)])).rows[0].n).toBe(1);
    expect((await q(`SELECT count(*)::int n FROM audit_log`)).rows[0].n).toBe(1);
  });

  it('a stored key the loaded 1C data no longer has is shown as such and can be replaced or removed', async () => {
    await mirror(REF(1), 'Тест Живой');
    await mirror(REF(2), 'Тест Помеченный', { DeletionMark: true });
    await q(`UPDATE clients SET ref_key_1c = $1 WHERE client_id = 1`, [REF(2)]);
    expect(await links.link(1)).toMatchObject({ refKey1c: REF(2), available: true, counterparty: null });
    expect(await code(links.setLink(1, REF(2), REF(2), admin, 'req-same'))).toBe('ok');
    expect((await links.setLink(1, REF(1), REF(2), admin, 'req-replace')).counterparty?.name).toBe('Тест Живой');
    await q(`UPDATE clients SET ref_key_1c = $1 WHERE client_id = 1`, [REF(2)]);
    expect((await links.setLink(1, null, REF(2), admin, 'req-remove')).refKey1c).toBeNull();
    expect(await code(links.setLink(1, REF(2), null, admin, 'req-marked'))).toBe('CLIENT_COUNTERPARTY_UNKNOWN');
  });

  it('without 1C data: the link is readable, nothing is offered and nothing can be linked; an existing key can still be removed', async () => {
    await q(`UPDATE clients SET ref_key_1c = $1 WHERE client_id = 2`, [REF(5)]);
    const check = async () => {
      expect(await links.link(2)).toEqual({ clientId: 2, clientName: 'ТОО «Тест Ромашка»', refKey1c: REF(5), available: false, counterparty: null });
      expect(await links.candidates(1, null)).toEqual([]);
      expect(await links.candidates(1, 'тест')).toEqual([]);
      expect(await code(links.setLink(1, REF(1), null, admin, 'req-none'))).toBe('CLIENT_COUNTERPARTY_UNKNOWN');
    };
    await check();
    await q(`ALTER TABLE onec_etl_mirror_rows RENAME TO onec_etl_mirror_rows_off`);
    try {
      await check();
      expect((await links.setLink(2, null, REF(5), admin, 'req-remove')).refKey1c).toBeNull();
    } finally {
      await q(`ALTER TABLE onec_etl_mirror_rows_off RENAME TO onec_etl_mirror_rows`);
    }
  });
});

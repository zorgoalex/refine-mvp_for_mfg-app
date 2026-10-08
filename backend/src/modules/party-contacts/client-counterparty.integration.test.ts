import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../../permissions/current-user';
import { ClientCounterpartyRepository } from './client-counterparty.repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const admin: CurrentUser = { id: '11', username: 'clients-admin', role: 'admin', roleId: 1, permissions: ['clients.update', 'clients.onec_data.view'] };
/** May link, may not see the data of 1C counterparties. */
const operator: CurrentUser = { id: '11', username: 'clients-admin', role: 'operator', roleId: 3, permissions: ['clients.update'] };
const REF = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe.skipIf(!databaseUrl)('the client ↔ 1C counterparty link (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_client_counterparty_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  let links: ClientCounterpartyRepository;
  let database: DatabaseService;
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
      CREATE TABLE clients(client_id bigint PRIMARY KEY, client_name citext NOT NULL UNIQUE, ref_key_1c uuid, edited_by bigint, notes text,
        is_active boolean NOT NULL DEFAULT true);
      CREATE UNIQUE INDEX idx_clients__ref_key_1c ON clients(ref_key_1c) WHERE ref_key_1c IS NOT NULL;
      CREATE TABLE client_phones(phone_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, client_id bigint NOT NULL, phone_number text NOT NULL);
      CREATE TABLE onec_etl_mirror_rows(source_id bigint, entity_code text, source_key text, deleted boolean NOT NULL DEFAULT false,
        data jsonb NOT NULL, missing_in_source_at timestamptz);
      CREATE TABLE onec_etl_entity_state(source_id bigint NOT NULL, entity_code text NOT NULL, revoked_at timestamptz, snapshot_version timestamptz,
        PRIMARY KEY(source_id, entity_code));
      INSERT INTO clients(client_id, client_name, notes) VALUES (1, 'Тест Айдын Адилов', 'заметка'), (2, 'ТОО «Тест Ромашка»', NULL), (3, 'Тест Третий', NULL);
      INSERT INTO client_phones(client_id, phone_number) VALUES (1, '+7 (701) 555-01-01'), (1, '8 777 123 45 67'), (3, '87015550909');`);
    database = {
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
    // The phones set has a fresh, not revoked snapshot unless a test says otherwise.
    await q(`DELETE FROM onec_etl_entity_state; INSERT INTO onec_etl_entity_state VALUES (1, 'counterparty_phones', NULL, now());
      DELETE FROM audit_log_related_entity; DELETE FROM audit_log; DELETE FROM onec_etl_mirror_rows;
      DELETE FROM client_phones WHERE client_id > 3; DELETE FROM clients WHERE client_id > 3; UPDATE clients SET ref_key_1c = NULL, edited_by = NULL, is_active = true`);
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
      dataHidden: false,
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
      expect(await links.link(2)).toEqual({ clientId: 2, clientName: 'ТОО «Тест Ромашка»', refKey1c: REF(5), available: false, counterparty: null, dataHidden: false });
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

  it('bulk view: only pairs unambiguous both ways are offered; shared, multiple and taken candidates are ambiguous; inactive and linked clients are out', async () => {
    await q(`INSERT INTO clients(client_id, client_name, is_active) VALUES (4, 'Тест Четвёртый', true), (5, 'Тест Пятый', true), (6, 'Тест Шестой', true),
      (7, 'Тест Неактивный', false), (8, 'Тест Без Пары', true), (9, 'Тест Девятый', true);
      INSERT INTO client_phones(client_id, phone_number) VALUES (4, '8 702 000 00 04'), (5, '87020000056'), (6, '+7 702 000 00 56'), (9, '87020000099')`);
    // Client 1: name and phone → both. Client 2: name only. Client 4: phone only.
    await mirror(REF(1), 'Тест Айдын Адилов', { Code: 'К-1' });
    await phone(REF(1), '8 701 555 01 01');
    await mirror(REF(2), 'Тест Ромашка ТОО');
    await mirror(REF(4), 'Совсем Иное Имя');
    await phone(REF(4), '+7 (702) 000-00-04');
    // Clients 5 and 6 share a phone with one counterparty: not unambiguous for either.
    await mirror(REF(5), 'Общий Телефон');
    await phone(REF(5), '87020000056');
    // Client 3 has two exact candidates.
    await mirror(REF(6), 'Тест Третий');
    await mirror(REF(7), 'ИП Тест Третий');
    // Client 9: its only candidate belongs to another (here inactive) client.
    await mirror(REF(9), 'Чужой');
    await phone(REF(9), '87020000099');
    await q(`UPDATE clients SET ref_key_1c = $1 WHERE client_id = 7`, [REF(9)]);
    // An inactive client is never offered, even with a perfect candidate.
    await mirror(REF(8), 'Тест Неактивный');

    const view = await links.matches();
    expect(view.available).toBe(true);
    expect(view.matches.map((match) => [match.clientId, match.counterparty.refKey1c, match.strength])).toEqual([
      [1, REF(1), 'both'], [4, REF(4), 'phone'], [2, REF(2), 'name'],
    ]);
    expect(view.matches[0]).toMatchObject({ clientName: 'Тест Айдын Адилов', clientPhones: ['+7 (701) 555-01-01', '8 777 123 45 67'], counterparty: { name: 'Тест Айдын Адилов', code: 'К-1' } });
    const ambiguous = view.ambiguous.map((row) => [row.clientId, row.candidates.map((candidate) => candidate.refKey1c).sort()] as const)
      .sort((x, y) => x[0] - y[0]);
    expect(ambiguous).toEqual([[3, [REF(6), REF(7)]], [5, [REF(5)]], [6, [REF(5)]], [9, [REF(9)]]]);
    expect(view.ambiguous.find((row) => row.clientId === 3)?.candidates.every((candidate) => candidate.matchedBy.join() === 'name')).toBe(true);
    expect(view.summary).toEqual({ clients: 8, linked: 0, both: 1, phone: 1, name: 1, ambiguous: 4, none: 1 });
  });

  it('bulk confirm: every possible pair is linked with its own audit row; impossible pairs are reported and skipped; a repeat links nothing twice', async () => {
    await q(`INSERT INTO clients(client_id, client_name) VALUES (4, 'Тест Четвёртый')`);
    await mirror(REF(1), 'Тест Контрагент 1', { Code: 'К-1' });
    await mirror(REF(2), 'Тест Контрагент 2');
    await mirror(REF(3), 'Тест Контрагент 3');
    await mirror(REF(4), 'Тест Контрагент 4');
    // Between the view and the confirmation: client 2 got a link in its card, counterparty 3 went to client 4.
    await links.setLink(2, REF(4), null, admin, 'req-card');
    await links.setLink(4, REF(3), null, admin, 'req-card-2');
    const pairs = [
      { clientId: 1, refKey1c: REF(1) }, { clientId: 2, refKey1c: REF(2) }, { clientId: 3, refKey1c: REF(3) },
      { clientId: 404, refKey1c: REF(2) },
    ];
    const first = await links.confirm([...pairs, { clientId: 3, refKey1c: REF(9) }].slice(0, 4), admin, 'req-bulk');
    expect(first).toEqual([
      { clientId: 1, refKey1c: REF(1), status: 'linked', holderClientId: null, holderClientName: null },
      { clientId: 2, refKey1c: REF(2), status: 'conflict', holderClientId: null, holderClientName: null },
      { clientId: 3, refKey1c: REF(3), status: 'taken', holderClientId: 4, holderClientName: 'Тест Четвёртый' },
      { clientId: 404, refKey1c: REF(2), status: 'not_found', holderClientId: null, holderClientName: null },
    ]);
    expect((await links.confirm([{ clientId: 3, refKey1c: REF(9) }], admin, 'req-bulk-unknown'))[0].status).toBe('unknown');
    // The same request again (the answer was lost): client 1 is reported linked, nothing is written twice.
    expect((await links.confirm(pairs, admin, 'req-bulk'))[0].status).toBe('linked');
    const audit = (await q(`SELECT entity_id, request_id, metadata_json->>'via' via, after_json->>'refKey1c' a FROM audit_log
      WHERE event = 'client.counterparty_linked' ORDER BY created_at`)).rows;
    expect(audit).toEqual([
      { entity_id: '2', request_id: 'req-card', via: 'card', a: REF(4) },
      { entity_id: '4', request_id: 'req-card-2', via: 'card', a: REF(3) },
      { entity_id: '1', request_id: 'req-bulk', via: 'bulk_confirm', a: REF(1) },
    ]);
    expect((await q(`SELECT client_id::text id, ref_key_1c FROM clients WHERE client_id IN (1,2,3) ORDER BY 1`)).rows)
      .toEqual([{ id: '1', ref_key_1c: REF(1) }, { id: '2', ref_key_1c: REF(4) }, { id: '3', ref_key_1c: null }]);
  });

  it('bulk confirm: an unexpected failure of one pair is reported as uncertain and does not hide or undo the others', async () => {
    await mirror(REF(1), 'Тест Контрагент 1');
    await mirror(REF(2), 'Тест Контрагент 2');
    await mirror(REF(3), 'Тест Контрагент 3');
    // The row of client 2 cannot be updated: its transaction fails in the middle, after the checks.
    await q(`CREATE FUNCTION fail_client_two() RETURNS trigger AS $$ BEGIN IF NEW.client_id = 2 THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_fail_client_two BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION fail_client_two()`);
    try {
      const results = await links.confirm([{ clientId: 1, refKey1c: REF(1) }, { clientId: 2, refKey1c: REF(2) }, { clientId: 3, refKey1c: REF(3) }], admin, 'req-bulk-fail');
      expect(results.map((row) => row.status)).toEqual(['linked', 'uncertain', 'linked']);
    } finally {
      await q(`DROP TRIGGER trg_fail_client_two ON clients; DROP FUNCTION fail_client_two()`);
    }
    expect((await q(`SELECT client_id::text id, ref_key_1c FROM clients WHERE client_id IN (1,2,3) ORDER BY 1`)).rows)
      .toEqual([{ id: '1', ref_key_1c: REF(1) }, { id: '2', ref_key_1c: null }, { id: '3', ref_key_1c: REF(3) }]);
    expect((await q(`SELECT entity_id FROM audit_log ORDER BY created_at`)).rows).toEqual([{ entity_id: '1' }, { entity_id: '3' }]);
    // The failed pair can be confirmed again once the cause is gone.
    expect((await links.confirm([{ clientId: 2, refKey1c: REF(2) }], admin, 'req-bulk-again'))[0].status).toBe('linked');
  });

  it('bulk confirm: a failure while the commit is acknowledged leaves the link written — the pair is uncertain, never «not written»', async () => {
    await mirror(REF(1), 'Тест Контрагент 1');
    await mirror(REF(2), 'Тест Контрагент 2');
    // The database commits the transaction of client 1, then the connection breaks before the answer.
    let transactions = 0;
    const flaky = {
      ...database,
      transaction: async <T>(handler: (tx: unknown) => Promise<T>) => {
        transactions += 1;
        const value = await (database as unknown as { transaction: (h: (tx: unknown) => Promise<T>) => Promise<T> }).transaction(handler);
        if (transactions === 1) throw new Error('Connection terminated unexpectedly');
        return value;
      },
    } as unknown as DatabaseService;
    const results = await new ClientCounterpartyRepository(flaky).confirm([{ clientId: 1, refKey1c: REF(1) }, { clientId: 2, refKey1c: REF(2) }], admin, 'req-bulk-commit');
    expect(results.map((row) => row.status)).toEqual(['uncertain', 'linked']);
    // The truth is in the row, and reading the link tells it: the uncertain pair IS linked, with its audit row.
    expect((await links.link(1)).refKey1c).toBe(REF(1));
    expect((await q(`SELECT entity_id FROM audit_log ORDER BY created_at`)).rows).toEqual([{ entity_id: '1' }, { entity_id: '2' }]);
  });

  it('bulk confirm must not be repeated blindly: a repeat after the link was removed in the card links the client again', async () => {
    // This is why the window verifies by reading instead of sending a part again after a lost answer.
    await mirror(REF(1), 'Тест Контрагент 1');
    await links.confirm([{ clientId: 1, refKey1c: REF(1) }], admin, 'req-bulk-1');
    await links.setLink(1, null, REF(1), admin, 'req-card-unlink');
    expect((await links.confirm([{ clientId: 1, refKey1c: REF(1) }], admin, 'req-bulk-1'))[0].status).toBe('linked');
    expect((await q(`SELECT event FROM audit_log ORDER BY created_at`)).rows.map((row) => row.event))
      .toEqual(['client.counterparty_linked', 'client.counterparty_unlinked', 'client.counterparty_linked']);
  });

  it('bulk view without 1C data: nothing to confirm, the totals are still counted', async () => {
    await q(`UPDATE clients SET ref_key_1c = $1 WHERE client_id = 2`, [REF(5)]);
    expect(await links.matches()).toEqual({ available: false, summary: { clients: 3, linked: 1, both: 0, phone: 0, name: 0, ambiguous: 0, none: 2 }, matches: [], ambiguous: [] });
  });

  it('phones are personal data: a revoked, expired or never loaded phones set gives no phones — in the card, the search, the suggestions and the bulk view', async () => {
    await mirror(REF(1), 'Совсем Другое Имя', { Code: 'К-1', 'ИдентификационныйНомер': '900101300123' });
    await phone(REF(1), '8 701 555 01 01');
    await q(`UPDATE clients SET ref_key_1c = $1 WHERE client_id = 2`, [REF(1)]);
    const seen = async () => ({
      card: (await links.link(2)).counterparty?.phones,
      search: (await links.candidates(1, '8701555')).length,
      suggested: (await links.candidates(1, null)).length,
      bulk: (await links.matches()).ambiguous.length + (await links.matches()).matches.length,
    });
    // Fresh snapshot: the phone is shown and is found; client 1 shares it, the counterparty is taken → ambiguous.
    expect(await seen()).toEqual({ card: ['8 701 555 01 01'], search: 1, suggested: 1, bulk: 1 });
    for (const state of [
      `UPDATE onec_etl_entity_state SET revoked_at = now()`,
      `UPDATE onec_etl_entity_state SET revoked_at = NULL, snapshot_version = now() - interval '31 days'`,
      `UPDATE onec_etl_entity_state SET snapshot_version = NULL`,
      `DELETE FROM onec_etl_entity_state`,
      // The state of another source does not open the rows of this one.
      `INSERT INTO onec_etl_entity_state VALUES (2, 'counterparty_phones', NULL, now())`,
    ]) {
      await q(state);
      // The rows still lie in the copy (the purge has not run), and nobody reads them.
      expect([state, await seen()]).toEqual([state, { card: [], search: 0, suggested: 0, bulk: 0 }]);
    }
    // The counterparty itself is not personal data of the phones set: the name and the code stay.
    expect((await links.link(2)).counterparty).toMatchObject({ name: 'Совсем Другое Имя', code: 'К-1', bin: '900101300123' });
    await q(`DELETE FROM onec_etl_entity_state; INSERT INTO onec_etl_entity_state VALUES (1, 'counterparty_phones', NULL, now() - interval '29 days')`);
    expect((await seen()).card).toEqual(['8 701 555 01 01']);
  });

  it('without clients.onec_data.view the name and the code are returned, phones and BIN/IIN are not — on reading and in the answer of the command', async () => {
    await mirror(REF(1), 'Тест Контрагент 1', { Code: 'К-1', 'ИдентификационныйНомер': '111111111111' });
    await phone(REF(1), '87015550101');
    const hidden = { refKey1c: REF(1), name: 'Тест Контрагент 1', code: 'К-1', bin: null, isBuyer: true, phones: [] };
    expect(await links.setLink(1, REF(1), null, operator, 'req-op')).toMatchObject({ refKey1c: REF(1), counterparty: hidden, dataHidden: true });
    expect(await links.setLink(1, REF(1), null, operator, 'req-op-repeat')).toMatchObject({ counterparty: hidden, dataHidden: true });
    expect(await links.link(1, undefined, false)).toMatchObject({ counterparty: hidden, dataHidden: true });
    expect((await links.link(1, undefined, true)).counterparty).toMatchObject({ bin: '111111111111', phones: ['87015550101'] });
    // BIN/IIN never reaches the audit, whoever links.
    const audit = (await q(`SELECT before_json::text || after_json::text || metadata_json::text AS body, metadata_json FROM audit_log`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].body).not.toContain('111111111111');
    expect(audit[0].metadata_json).toEqual({ counterpartyCode: 'К-1', via: 'card' });
  });
});

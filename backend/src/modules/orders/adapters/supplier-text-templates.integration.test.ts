import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { SUPPLIER_TEXT_LIMITS } from '../domain/supplier-text-template';
import { PgSupplierTextTemplatesRepository } from './pg-supplier-text-templates-repository';

// Committed fixtures in an OWNED disposable database only (spec_erp/reviews/supply-screen-remarks/run-races.cjs, EXTRA_MIGRATIONS=239_…).
const url = process.env.ERP_PROCUREMENT_RACE_DATABASE_URL;
const targetEnv = process.env.ERP_PROCUREMENT_RACE_TARGET_ENV;

class CommittedDatabase extends DatabaseService {
  readonly tx: TransactionClient;
  constructor(readonly client: PoolClient) {
    super(new ConfigService<BackendEnv, true>({ DATABASE_QUERY_TIMEOUT_MS: 15000 }), {} as never);
    this.tx = { raw: client, query: this.query.bind(this) };
  }
  override async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) {
    return this.client.query<T>(sql, [...params]);
  }
  override async transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
    await this.client.query('BEGIN');
    await this.client.query("SET LOCAL lock_timeout='10s'");
    try {
      const result = await handler(this.tx);
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }
}

const SECRET = 'token: secret-example';

describe.skipIf(!url)('Personal supplier text templates — real PostgreSQL', { timeout: 120000 }, () => {
  let pool: Pool;
  let connA: PoolClient;
  let connB: PoolClient;
  let repoA: PgSupplierTextTemplatesRepository;
  let repoB: PgSupplierTextTemplatesRepository;
  const tag = 'E2E-Тест-ШТ-' + randomUUID().slice(0, 8);
  let admin: CurrentUser;
  let other: CurrentUser;
  const base = (user: CurrentUser) => ({ currentUser: user, commandKey: randomUUID(), requestId: randomUUID() });
  const create = (repo: PgSupplierTextTemplatesRepository, name: string, user = admin) =>
    repo.create({ ...base(user), name, body: 'Заявка {номер}\n{позиции}', lineTemplate: '{материал} — {количество_с_единицей}' });
  const ownRow = async (id: number) => (await connA.query(
    'SELECT name, body, version, deleted_at, owner_user_id::text AS owner_user_id FROM supplier_request_user_text_templates WHERE template_id = $1', [id])).rows[0];
  /** Общая таблица целиком — личные команды не должны менять в ней ничего. */
  const sharedSnapshot = async () => JSON.stringify((await connA.query(
    'SELECT template_id::text, name, body, line_template, is_default, version, deleted_at FROM supplier_request_text_templates ORDER BY template_id')).rows);
  let sharedBefore: string;
  const choiceRow = async (user: CurrentUser) => (await connA.query(
    'SELECT shared_template_id, own_template_id, revision FROM supplier_request_text_template_defaults WHERE user_id = $1', [user.id])).rows[0];
  const revisionOf = async (user: CurrentUser) => Number((await choiceRow(user))?.revision ?? 0);
  const audits = async (requestId: string) => (await connA.query(
    `SELECT event, before_json, after_json, diff_json, metadata_json FROM audit_log WHERE request_id = $1 ORDER BY audit_id`, [requestId])).rows;
  const errorOf = async (promise: Promise<unknown>) => promise.then(() => null, (error: { status?: number; code?: string; statusCode?: number }) => error);

  beforeAll(async () => {
    expect(targetEnv).toBe('backend-test');
    expect(decodeURIComponent(new URL(url!).pathname.slice(1)).startsWith('procurement_race_')).toBe(true);
    pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 20000 });
    connA = await pool.connect();
    connB = await pool.connect();
    repoA = new PgSupplierTextTemplatesRepository(new CommittedDatabase(connA));
    repoB = new PgSupplierTextTemplatesRepository(new CommittedDatabase(connB));
    const user = async (suffix: string) => Number((await connA.query(
      `INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'E2E-NO-LOGIN', 1) RETURNING user_id`,
      [`${tag}-${suffix}`, `${tag}-${suffix}@example.invalid`])).rows[0].user_id);
    const perms = ['procurement.view'];
    admin = { id: String(await user('admin')), username: `${tag}-admin`, role: 'admin', roleId: 1, permissions: perms };
    other = { id: String(await user('other')), username: `${tag}-other`, role: 'admin', roleId: 1, permissions: perms };
    // Сбой аудита по требованию теста (только в owned-базе): триггер смотрит на настройку сессии.
    await connA.query(`CREATE OR REPLACE FUNCTION e2e_fail_template_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('e2e.fail_template_audit', true) = 'on' AND NEW.event LIKE 'procurement.supplier_text_template_%' THEN
          RAISE EXCEPTION 'e2e audit failure';
        END IF;
        RETURN NEW;
      END $$`);
    await connA.query('DROP TRIGGER IF EXISTS e2e_fail_template_audit ON audit_log');
    await connA.query('CREATE TRIGGER e2e_fail_template_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION e2e_fail_template_audit()');
    sharedBefore = await sharedSnapshot();
  }, 60000);

  afterAll(async () => {
    await connA?.query('DROP TRIGGER IF EXISTS e2e_fail_template_audit ON audit_log').catch(() => undefined);
    try { connA?.release(); } catch { /* released */ }
    try { connB?.release(); } catch { /* released */ }
    await pool?.end().catch(() => undefined);
  });

  it('seed: the shared «Стандартный» is the effective default of every user; the previous route lists shared templates only', async () => {
    const { templates: mine, defaultRevision } = await repoA.listVisible(admin);
    expect(defaultRevision).toBe(0);
    expect(mine.filter((t) => t.isDefault)).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: 'Стандартный', isDefault: true, scope: 'shared', lineTemplate: '{материал} — {количество_с_единицей}' });
    const shared = await repoA.listShared();
    expect(shared.every((t) => t.scope === 'shared')).toBe(true);
    expect(shared.filter((t) => t.isDefault)).toHaveLength(1);
  });

  it('create → personal template; audit snapshot only hashes free text; replay returns the stored result without a second audit', async () => {
    const command = { ...base(admin), name: `${tag} ${SECRET}`, body: `{номер} ${SECRET}\n{позиции}`, lineTemplate: `{материал} ${SECRET}` };
    const first = await repoA.create(command);
    expect(first.changed).toBe(true);
    expect(first.template).toMatchObject({ name: `${tag} ${SECRET}`, isDefault: false, version: 1, scope: 'own' });
    expect(first.templates.some((t) => t.templateId === first.template!.templateId)).toBe(true);
    expect((await ownRow(first.template!.templateId)).owner_user_id).toBe(admin.id);
    // Общая таблица не тронута.
    expect(await sharedSnapshot()).toEqual(sharedBefore);
    const again = await repoA.create(command);
    expect(again).toEqual(first);
    const rows = await audits(command.requestId);
    expect(rows.map((r) => r.event)).toEqual(['procurement.supplier_text_template_created']);
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain('secret-example');
    expect(serialized).not.toContain(tag);
    expect(rows[0].after_json).toMatchObject({ scope: 'own', ownerUserId: Number(admin.id), name: { length: command.name.length } });
    expect(rows[0].after_json.name.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].metadata_json).toMatchObject({ ownerUserId: Number(admin.id) });
    // Тот же ключ, другое тело — 409; тот же ключ у другого пользователя — 409.
    expect(await errorOf(repoA.create({ ...command, name: `${tag} другое` }))).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await errorOf(repoB.create({ ...command, currentUser: other }))).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const del = { ...base(admin), templateId: first.template!.templateId, expectedVersion: 1 };
    await repoA.remove(del);
    expect(JSON.stringify(await audits(del.requestId))).not.toContain('secret-example');
  });

  it('isolation: another user never sees the template and gets 404 for update/delete/default; nothing changes', async () => {
    const mine = (await create(repoA, `${tag} Личный`)).template!;
    expect((await repoB.listVisible(other)).templates.some((t) => t.templateId === mine.templateId)).toBe(false);
    expect((await repoA.listShared()).some((t) => t.templateId === mine.templateId)).toBe(false);
    for (const attempt of [
      repoB.update({ ...base(other), templateId: mine.templateId, expectedVersion: 1, body: '{номер}' }),
      repoB.remove({ ...base(other), templateId: mine.templateId, expectedVersion: 1 }),
      repoB.setDefault({ ...base(other), templateId: mine.templateId, expectedVersion: 1, expectedDefaultRevision: 0 }),
    ]) {
      expect(await errorOf(attempt)).toMatchObject({ statusCode: 404, code: 'SUPPLIER_TEXT_TEMPLATE_NOT_FOUND' });
    }
    expect(await ownRow(mine.templateId)).toMatchObject({ version: 1, deleted_at: null, body: 'Заявка {номер}\n{позиции}' });
    expect(await choiceRow(other)).toBeUndefined();
    // Составной внешний ключ: чужой личный шаблон нельзя выбрать даже прямым SQL.
    expect(await errorOf(connA.query(
      'INSERT INTO supplier_request_text_template_defaults (user_id, own_template_id) VALUES ($1, $2)', [other.id, mine.templateId])))
      .toMatchObject({ code: '23503' });
    // Одинаковое имя у двух пользователей — можно; у одного — нельзя.
    const theirs = (await create(repoB, `${tag} Личный`, other)).template!;
    expect(await errorOf(create(repoA, `  ${tag} ЛИЧНЫЙ `))).toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_NAME_TAKEN' });
    await repoA.remove({ ...base(admin), templateId: mine.templateId, expectedVersion: 1 });
    await repoB.remove({ ...base(other), templateId: theirs.templateId, expectedVersion: 1 });
  });

  it('shared templates are read-only: update/delete → 409, the shared table stays byte-identical', async () => {
    const seed = (await repoA.listShared()).find((t) => t.isDefault)!;
    expect(await errorOf(repoA.update({ ...base(admin), templateId: seed.templateId, expectedVersion: seed.version, body: '{номер}' })))
      .toMatchObject({ statusCode: 409, code: 'SUPPLIER_TEXT_TEMPLATE_SHARED_READ_ONLY' });
    expect(await errorOf(repoA.remove({ ...base(admin), templateId: seed.templateId, expectedVersion: seed.version })))
      .toMatchObject({ statusCode: 409, code: 'SUPPLIER_TEXT_TEMPLATE_SHARED_READ_ONLY' });
    expect(await sharedSnapshot()).toEqual(sharedBefore);
  });

  it('validation: unknown field, unclosed brace, empty name → 422; name is free again after a soft delete', async () => {
    expect(await errorOf(repoA.create({ ...base(admin), name: `${tag} x`, body: '{неизвестное}', lineTemplate: '{материал}' })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_INVALID' });
    expect(await errorOf(repoA.create({ ...base(admin), name: `${tag} x`, body: '{номер', lineTemplate: '{материал}' })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_INVALID' });
    expect(await errorOf(repoA.create({ ...base(admin), name: '   ', body: '{номер}', lineTemplate: '{материал}' })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_INVALID' });
    expect(await errorOf(repoA.create({ ...base(admin), name: `${tag} x`, body: '{номер}', lineTemplate: '{номер}' })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_INVALID' });
    const made = await create(repoA, `${tag} Имя`);
    await repoA.remove({ ...base(admin), templateId: made.template!.templateId, expectedVersion: 1 });
    const reused = await create(repoA, `${tag} Имя`);
    await repoA.remove({ ...base(admin), templateId: reused.template!.templateId, expectedVersion: 1 });
  });

  it('update: version check, no-op without changes, rename conflict', async () => {
    const made = (await create(repoA, `${tag} Правка`)).template!;
    const other1 = (await create(repoA, `${tag} Другой`)).template!;
    const noop = await repoA.update({ ...base(admin), templateId: made.templateId, expectedVersion: 1, name: `${tag} Правка` });
    expect(noop.changed).toBe(false);
    expect((await ownRow(made.templateId)).version).toBe(1);
    const updated = await repoA.update({ ...base(admin), templateId: made.templateId, expectedVersion: 1, body: '{поставщик}\n{позиции}' });
    expect(updated.template).toMatchObject({ version: 2, body: '{поставщик}\n{позиции}', scope: 'own' });
    expect(await errorOf(repoA.update({ ...base(admin), templateId: made.templateId, expectedVersion: 1, body: '{номер}' })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_VERSION_CONFLICT' });
    expect(await errorOf(repoA.update({ ...base(admin), templateId: made.templateId, expectedVersion: 2, name: `${tag} другой` })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_NAME_TAKEN' });
    expect(await errorOf(repoA.update({ ...base(admin), templateId: 999999999, expectedVersion: 1, body: '{номер}' })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_NOT_FOUND' });
    await repoA.remove({ ...base(admin), templateId: made.templateId, expectedVersion: 2 });
    await repoA.remove({ ...base(admin), templateId: other1.templateId, expectedVersion: 1 });
  });

  it('personal default: own or shared, per user; the shared default is untouched; deleting the chosen template falls back', async () => {
    const seed = (await repoA.listShared()).find((t) => t.isDefault)!;
    const revision = async () => (await repoA.listVisible(admin)).defaultRevision;
    const a = (await create(repoA, `${tag} A`)).template!;
    expect(await revision()).toBe(0);
    const choose = { ...base(admin), templateId: a.templateId, expectedVersion: 1, expectedDefaultRevision: 0 };
    const result = await repoA.setDefault(choose);
    // Версия шаблона от выбора не меняется; растёт ревизия личного выбора.
    expect(result).toMatchObject({ changed: true, defaultRevision: 1, template: { templateId: a.templateId, isDefault: true, version: 1 } });
    expect(result.templates[0].templateId).toBe(a.templateId);
    expect(result.templates.filter((t) => t.isDefault)).toHaveLength(1);
    // У другого пользователя и в общей таблице ничего не изменилось.
    const theirs = await repoB.listVisible(other);
    expect(theirs.templates.find((t) => t.isDefault)).toMatchObject({ templateId: seed.templateId });
    expect(theirs.defaultRevision).toBe(0);
    expect(await sharedSnapshot()).toEqual(sharedBefore);
    const [audit] = await audits(choose.requestId);
    expect(audit.event).toBe('procurement.supplier_text_template_default_changed');
    expect(audit.metadata_json).toMatchObject({ userId: Number(admin.id), previousTemplateId: seed.templateId, templateId: a.templateId, scope: 'own' });
    // Повтор команды — сохранённый ответ; повтор выбора новым ключом — no-op без роста ревизии и без аудита.
    expect(await repoA.setDefault(choose)).toEqual(result);
    const noop = { ...base(admin), templateId: a.templateId, expectedVersion: 1, expectedDefaultRevision: 1 };
    expect(await repoA.setDefault(noop)).toMatchObject({ changed: false, defaultRevision: 1 });
    expect(await audits(noop.requestId)).toHaveLength(0);
    expect(await audits(choose.requestId)).toHaveLength(1);
    // Устаревшая версия шаблона — 409; устаревшая ревизия выбора — 409.
    expect(await errorOf(repoA.setDefault({ ...base(admin), templateId: seed.templateId, expectedVersion: seed.version + 5, expectedDefaultRevision: 1 })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_VERSION_CONFLICT' });
    expect(await errorOf(repoA.setDefault({ ...base(admin), templateId: seed.templateId, expectedVersion: seed.version, expectedDefaultRevision: 0 })))
      .toMatchObject({ statusCode: 409, code: 'SUPPLIER_TEXT_TEMPLATE_DEFAULT_CONFLICT' });
    // Возврат к общему по умолчанию: цели пусты, ревизия растёт и не сбрасывается.
    const back = await repoA.setDefault({ ...base(admin), templateId: seed.templateId, expectedVersion: seed.version, expectedDefaultRevision: 1 });
    expect(back.templates.find((t) => t.isDefault)).toMatchObject({ templateId: seed.templateId });
    expect(back.defaultRevision).toBe(2);
    expect(await choiceRow(admin)).toMatchObject({ shared_template_id: null, own_template_id: null, revision: 2 });
    // Удаление выбранного личного шаблона: выбор снимается в той же транзакции, ревизия растёт.
    await repoA.setDefault({ ...base(admin), templateId: a.templateId, expectedVersion: 1, expectedDefaultRevision: 2 });
    const del = { ...base(admin), templateId: a.templateId, expectedVersion: 1 };
    const removed = await repoA.remove(del);
    expect(removed.templates.find((t) => t.isDefault)).toMatchObject({ templateId: seed.templateId });
    expect(removed.defaultRevision).toBe(4);
    expect((await audits(del.requestId))[0].metadata_json).toMatchObject({ wasPersonalDefault: true });
    expect(await choiceRow(admin)).toMatchObject({ shared_template_id: null, own_template_id: null, revision: 4 });
  });

  it('R3-1: default(X) done, response lost → later choice Y → replay of the same key returns the stored result and keeps Y', async () => {
    const before = await revisionOf(other);
    const x = (await create(repoB, `${tag} X`, other)).template!;
    const y = (await create(repoB, `${tag} Y`, other)).template!;
    const k = { ...base(other), templateId: x.templateId, expectedVersion: 1, expectedDefaultRevision: before };
    const first = await repoB.setDefault(k);
    await repoB.setDefault({ ...base(other), templateId: y.templateId, expectedVersion: 1, expectedDefaultRevision: before + 1 });
    expect(await repoB.setDefault(k)).toEqual(first);
    expect((await repoB.listVisible(other)).templates.find((t) => t.isDefault)).toMatchObject({ templateId: y.templateId });
    expect(await audits(k.requestId)).toHaveLength(1);
    await repoB.remove({ ...base(other), templateId: x.templateId, expectedVersion: 1 });
    await repoB.remove({ ...base(other), templateId: y.templateId, expectedVersion: 1 });
  });

  it('R4-1: default(X) never reached the server → later choice Y → its first execution is refused by the revision, Y stays, nothing is stored', async () => {
    const before = await revisionOf(other);
    const x = (await create(repoB, `${tag} X2`, other)).template!;
    const y = (await create(repoB, `${tag} Y2`, other)).template!;
    // K сформирован при ревизии `before`, но до сервера не дошёл (404 маршрута после отката backend).
    const k = { ...base(other), templateId: x.templateId, expectedVersion: 1, expectedDefaultRevision: before };
    await repoB.setDefault({ ...base(other), templateId: y.templateId, expectedVersion: 1, expectedDefaultRevision: before });
    expect(await errorOf(repoB.setDefault(k))).toMatchObject({ statusCode: 409, code: 'SUPPLIER_TEXT_TEMPLATE_DEFAULT_CONFLICT' });
    expect((await repoB.listVisible(other)).templates.find((t) => t.isDefault)).toMatchObject({ templateId: y.templateId });
    expect(await audits(k.requestId)).toHaveLength(0);
    expect(Number((await connA.query('SELECT count(*) AS c FROM procurement_command_keys WHERE request_id = $1', [k.commandKey])).rows[0].c)).toBe(0);
    await repoB.remove({ ...base(other), templateId: x.templateId, expectedVersion: 1 });
    await repoB.remove({ ...base(other), templateId: y.templateId, expectedVersion: 1 });
  });

  it('R5-1: default(X) never reached the server → Y chosen → Y deleted (the choice row stays, revision grows) → first execution of K is refused', async () => {
    const before = await revisionOf(other);
    const x = (await create(repoB, `${tag} X3`, other)).template!;
    const y = (await create(repoB, `${tag} Y3`, other)).template!;
    const k = { ...base(other), templateId: x.templateId, expectedVersion: 1, expectedDefaultRevision: before };
    await repoB.setDefault({ ...base(other), templateId: y.templateId, expectedVersion: 1, expectedDefaultRevision: before });
    await repoB.remove({ ...base(other), templateId: y.templateId, expectedVersion: 1 });
    expect(await choiceRow(other)).toMatchObject({ shared_template_id: null, own_template_id: null, revision: before + 2 });
    expect(await errorOf(repoB.setDefault(k))).toMatchObject({ statusCode: 409, code: 'SUPPLIER_TEXT_TEMPLATE_DEFAULT_CONFLICT' });
    const seed = (await repoA.listShared()).find((t) => t.isDefault)!;
    expect((await repoB.listVisible(other)).templates.find((t) => t.isDefault)).toMatchObject({ templateId: seed.templateId });
    await repoB.remove({ ...base(other), templateId: x.templateId, expectedVersion: 1 });
  });

  it('code review R1-2: a read concurrent with create+default always has exactly one default and it is in the list', async () => {
    for (let round = 0; round < 8; round += 1) {
      const revision = await revisionOf(other);
      const writer = (async () => {
        const made = (await create(repoB, `${tag} Снимок ${round}`, other)).template!;
        await repoB.setDefault({ ...base(other), templateId: made.templateId, expectedVersion: 1, expectedDefaultRevision: revision });
        return made.templateId;
      })();
      const reads = await Promise.all([repoA.listVisible(other), repoA.listVisible(other), repoA.listVisible(other)]);
      for (const read of reads) expect(read.templates.filter((t) => t.isDefault)).toHaveLength(1);
      await repoB.remove({ ...base(other), templateId: await writer, expectedVersion: 1 });
    }
  });

  it('audit failure rolls the whole command back (no template, no key stored); the same key then runs', async () => {
    const command = { ...base(admin), name: `${tag} Сбой`, body: '{номер}\n{позиции}', lineTemplate: '{материал}' };
    await connA.query("SELECT set_config('e2e.fail_template_audit', 'on', false)");
    try {
      expect(await errorOf(repoA.create(command))).not.toBeNull();
    } finally {
      await connA.query("SELECT set_config('e2e.fail_template_audit', 'off', false)");
    }
    expect(Number((await connA.query('SELECT count(*) AS c FROM supplier_request_user_text_templates WHERE owner_user_id = $1 AND deleted_at IS NULL', [admin.id])).rows[0].c)).toBe(0);
    expect(Number((await connA.query('SELECT count(*) AS c FROM procurement_command_keys WHERE request_id = $1', [command.commandKey])).rows[0].c)).toBe(0);
    const made = await repoA.create(command);
    expect(made.changed).toBe(true);
    await repoA.remove({ ...base(admin), templateId: made.template!.templateId, expectedVersion: 1 });
  });

  it('concurrent default/delete of one own template (two sessions of the owner): no dangling choice', async () => {
    const t = (await create(repoA, `${tag} Гонка`)).template!;
    const results = await Promise.allSettled([
      repoA.setDefault({ ...base(admin), templateId: t.templateId, expectedVersion: 1, expectedDefaultRevision: await revisionOf(admin) }),
      repoB.remove({ ...base(admin), templateId: t.templateId, expectedVersion: 1 }),
    ]);
    // Удаление всегда проходит (версия шаблона от выбора не меняется); выбор либо снят удалением, либо отклонён 404.
    expect(results[1].status).toBe('fulfilled');
    if (results[0].status === 'rejected') expect(results[0].reason.code).toBe('SUPPLIER_TEXT_TEMPLATE_NOT_FOUND');
    expect(await choiceRow(admin)).toMatchObject({ shared_template_id: null, own_template_id: null });
    expect((await repoA.listVisible(admin)).templates.filter((x) => x.isDefault)).toHaveLength(1);
  });

  it(`concurrent creates at the limit: exactly ${SUPPLIER_TEXT_LIMITS.ownTemplates} own templates; another user is not limited by them`, async () => {
    const active = async () => Number((await connA.query(
      'SELECT count(*) AS c FROM supplier_request_user_text_templates WHERE owner_user_id = $1 AND deleted_at IS NULL', [admin.id])).rows[0].c);
    const made: number[] = [];
    for (let i = await active(); i < SUPPLIER_TEXT_LIMITS.ownTemplates - 1; i += 1) {
      made.push((await create(repoA, `${tag} L${i}`)).template!.templateId);
    }
    const results = await Promise.allSettled([create(repoA, `${tag} X1`), create(repoB, `${tag} X2`)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('SUPPLIER_TEXT_TEMPLATE_LIMIT');
    expect(await active()).toBe(SUPPLIER_TEXT_LIMITS.ownTemplates);
    const theirs = (await create(repoB, `${tag} чужой лимит`, other)).template!;
    await repoB.remove({ ...base(other), templateId: theirs.templateId, expectedVersion: 1 });
    for (const r of results) if (r.status === 'fulfilled') made.push(r.value.template!.templateId);
    for (const id of made) await repoA.remove({ ...base(admin), templateId: id, expectedVersion: 1 });
    expect(await active()).toBe(0);
    expect(await sharedSnapshot()).toEqual(sharedBefore);
  });
});

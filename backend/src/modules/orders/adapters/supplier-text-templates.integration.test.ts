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

// Committed fixtures in an OWNED disposable database only (spec_erp/reviews/supplier-text-templates/run-races.cjs).
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

describe.skipIf(!url)('Supplier text templates — real PostgreSQL', { timeout: 120000 }, () => {
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
  const row = async (id: number) => (await connA.query(
    'SELECT name, is_default, version, deleted_at FROM supplier_request_text_templates WHERE template_id = $1', [id])).rows[0];
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
    const perms = ['procurement.view', 'procurement.manage'];
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
  }, 60000);

  afterAll(async () => {
    await connA?.query('DROP TRIGGER IF EXISTS e2e_fail_template_audit ON audit_log').catch(() => undefined);
    try { connA?.release(); } catch { /* released */ }
    try { connB?.release(); } catch { /* released */ }
    await pool?.end().catch(() => undefined);
  });

  it('seed: migration 229 leaves exactly one default «Стандартный»', async () => {
    const list = await repoA.list();
    expect(list.filter((t) => t.isDefault)).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Стандартный', isDefault: true, lineTemplate: '{материал} — {количество_с_единицей}' });
  });

  it('create → audit snapshot only hashes free text; replay returns the stored result without a second audit', async () => {
    const command = { ...base(admin), name: `${tag} ${SECRET}`, body: `{номер} ${SECRET}\n{позиции}`, lineTemplate: `{материал} ${SECRET}` };
    const first = await repoA.create(command);
    expect(first.changed).toBe(true);
    expect(first.template).toMatchObject({ name: `${tag} ${SECRET}`, isDefault: false, version: 1 });
    expect(first.templates.some((t) => t.templateId === first.template!.templateId)).toBe(true);
    const again = await repoA.create(command);
    expect(again).toEqual(first);
    const rows = await audits(command.requestId);
    expect(rows.map((r) => r.event)).toEqual(['procurement.supplier_text_template_created']);
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain('secret-example');
    expect(serialized).not.toContain(tag);
    expect(rows[0].after_json.name).toMatchObject({ length: command.name.length });
    expect(rows[0].after_json.name.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Тот же ключ, другое тело — 409.
    expect(await errorOf(repoA.create({ ...command, name: `${tag} другое` }))).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    // Удаление (чтобы не мешать лимиту) с проверкой отсутствия текста в аудите удаления.
    const del = { ...base(admin), templateId: first.template!.templateId, expectedVersion: 1 };
    await repoA.remove(del);
    expect(JSON.stringify(await audits(del.requestId))).not.toContain('secret-example');
  });

  it('validation: unknown field, unclosed brace, empty name → 422; taken name (case/space-insensitive) → 409', async () => {
    expect(await errorOf(repoA.create({ ...base(admin), name: `${tag} x`, body: '{неизвестное}', lineTemplate: '{материал}' })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_INVALID' });
    expect(await errorOf(repoA.create({ ...base(admin), name: `${tag} x`, body: '{номер', lineTemplate: '{материал}' })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_INVALID' });
    expect(await errorOf(repoA.create({ ...base(admin), name: '   ', body: '{номер}', lineTemplate: '{материал}' })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_INVALID' });
    expect(await errorOf(repoA.create({ ...base(admin), name: `${tag} x`, body: '{номер}', lineTemplate: '{номер}' })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_INVALID' });
    const made = await create(repoA, `${tag} Имя`);
    expect(await errorOf(create(repoA, `  ${tag} ИМЯ `))).toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_NAME_TAKEN' });
    await repoA.remove({ ...base(admin), templateId: made.template!.templateId, expectedVersion: 1 });
    // После мягкого удаления имя свободно.
    const reused = await create(repoA, `${tag} Имя`);
    await repoA.remove({ ...base(admin), templateId: reused.template!.templateId, expectedVersion: 1 });
  });

  it('update: version check, no-op without changes, rename conflict', async () => {
    const made = (await create(repoA, `${tag} Правка`)).template!;
    const other1 = (await create(repoA, `${tag} Другой`)).template!;
    const noop = await repoA.update({ ...base(admin), templateId: made.templateId, expectedVersion: 1, name: `${tag} Правка` });
    expect(noop.changed).toBe(false);
    expect((await row(made.templateId)).version).toBe(1);
    const updated = await repoA.update({ ...base(admin), templateId: made.templateId, expectedVersion: 1, body: '{поставщик}\n{позиции}' });
    expect(updated.template).toMatchObject({ version: 2, body: '{поставщик}\n{позиции}' });
    expect(await errorOf(repoA.update({ ...base(admin), templateId: made.templateId, expectedVersion: 1, body: '{номер}' })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_VERSION_CONFLICT' });
    expect(await errorOf(repoA.update({ ...base(admin), templateId: made.templateId, expectedVersion: 2, name: `${tag} другой` })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_NAME_TAKEN' });
    expect(await errorOf(repoA.update({ ...base(admin), templateId: 999999999, expectedVersion: 1, body: '{номер}' })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_NOT_FOUND' });
    await repoA.remove({ ...base(admin), templateId: made.templateId, expectedVersion: 2 });
    await repoA.remove({ ...base(admin), templateId: other1.templateId, expectedVersion: 1 });
  });

  it('default: atomic swap bumps both versions with linked audit; stale choice rejected; replay of a lost response keeps a later choice', async () => {
    const seed = (await repoA.list()).find((t) => t.isDefault)!;
    const a = (await create(repoA, `${tag} A`)).template!;
    const b = (await create(repoA, `${tag} B`)).template!;
    const choose = { ...base(admin), templateId: a.templateId, expectedVersion: 1 };
    const result = await repoA.setDefault(choose);
    expect(result.template).toMatchObject({ isDefault: true, version: 2 });
    expect(await row(seed.templateId)).toMatchObject({ is_default: false, version: seed.version + 1 });
    const [audit] = await audits(choose.requestId);
    expect(audit.event).toBe('procurement.supplier_text_template_default_changed');
    expect(audit.metadata_json).toMatchObject({ previousDefaultTemplateId: seed.templateId, defaultTemplateId: a.templateId });
    // Устаревшая версия (B менялся после просмотра) — 409.
    await repoA.update({ ...base(admin), templateId: b.templateId, expectedVersion: 1, body: '{номер} {позиции}' });
    expect(await errorOf(repoA.setDefault({ ...base(other), templateId: b.templateId, expectedVersion: 1 })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_VERSION_CONFLICT' });
    // Позже другой пользователь выбрал B; повтор потерянного ответа про A не возвращает A.
    await repoB.setDefault({ ...base(other), templateId: b.templateId, expectedVersion: 2 });
    const replay = await repoA.setDefault(choose);
    expect(replay).toEqual(result);
    expect((await row(b.templateId)).is_default).toBe(true);
    expect((await row(a.templateId)).is_default).toBe(false);
    expect((await audits(choose.requestId))).toHaveLength(1);
    // По умолчанию не удаляется.
    expect(await errorOf(repoA.remove({ ...base(admin), templateId: b.templateId, expectedVersion: (await row(b.templateId)).version })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_DEFAULT_DELETE' });
    // Вернуть «Стандартный» по умолчанию и убрать свои.
    await repoA.setDefault({ ...base(admin), templateId: seed.templateId, expectedVersion: (await row(seed.templateId)).version });
    await repoA.remove({ ...base(admin), templateId: a.templateId, expectedVersion: (await row(a.templateId)).version });
    await repoA.remove({ ...base(admin), templateId: b.templateId, expectedVersion: (await row(b.templateId)).version });
  });

  it('audit failure after unsetting the old default rolls everything back (default unchanged, no key stored)', async () => {
    const seed = (await repoA.list()).find((t) => t.isDefault)!;
    const a = (await create(repoA, `${tag} Сбой`)).template!;
    const command = { ...base(admin), templateId: a.templateId, expectedVersion: 1 };
    await connA.query("SELECT set_config('e2e.fail_template_audit', 'on', false)");
    try {
      expect(await errorOf(repoA.setDefault(command))).not.toBeNull();
    } finally {
      await connA.query("SELECT set_config('e2e.fail_template_audit', 'off', false)");
    }
    expect(await row(seed.templateId)).toMatchObject({ is_default: true, version: seed.version });
    expect(await row(a.templateId)).toMatchObject({ is_default: false, version: 1 });
    expect(Number((await connA.query('SELECT count(*) AS c FROM procurement_command_keys WHERE request_id = $1', [command.commandKey])).rows[0].c)).toBe(0);
    // Тот же ключ после восстановления — выполняется заново.
    expect((await repoA.setDefault(command)).changed).toBe(true);
    await repoA.setDefault({ ...base(admin), templateId: seed.templateId, expectedVersion: (await row(seed.templateId)).version });
    await repoA.remove({ ...base(admin), templateId: a.templateId, expectedVersion: (await row(a.templateId)).version });
  });

  it('the last template and the only default are not deleted', async () => {
    const seed = (await repoA.list()).find((t) => t.isDefault)!;
    expect(await errorOf(repoA.remove({ ...base(admin), templateId: seed.templateId, expectedVersion: seed.version })))
      .toMatchObject({ code: 'SUPPLIER_TEXT_TEMPLATE_DEFAULT_DELETE' });
  });

  it('concurrent default/delete on one template: one wins, the other gets a version conflict; invariant holds', async () => {
    const seed = (await repoA.list()).find((t) => t.isDefault)!;
    const t = (await create(repoA, `${tag} Гонка`)).template!;
    const results = await Promise.allSettled([
      repoA.setDefault({ ...base(admin), templateId: t.templateId, expectedVersion: 1 }),
      repoB.remove({ ...base(other), templateId: t.templateId, expectedVersion: 1 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(['SUPPLIER_TEXT_TEMPLATE_VERSION_CONFLICT', 'SUPPLIER_TEXT_TEMPLATE_NOT_FOUND']).toContain(rejected.reason.code);
    const defaults = (await connA.query('SELECT count(*) AS c FROM supplier_request_text_templates WHERE is_default AND deleted_at IS NULL')).rows[0];
    expect(Number(defaults.c)).toBe(1);
    const current = await row(t.templateId);
    if (current.is_default) {
      await repoA.setDefault({ ...base(admin), templateId: seed.templateId, expectedVersion: (await row(seed.templateId)).version });
      await repoA.remove({ ...base(admin), templateId: t.templateId, expectedVersion: (await row(t.templateId)).version });
    }
  });

  it(`concurrent creates at the limit: exactly ${SUPPLIER_TEXT_LIMITS.activeTemplates} active`, async () => {
    const active = async () => Number((await connA.query('SELECT count(*) AS c FROM supplier_request_text_templates WHERE deleted_at IS NULL')).rows[0].c);
    const made: number[] = [];
    for (let i = await active(); i < SUPPLIER_TEXT_LIMITS.activeTemplates - 1; i += 1) {
      made.push((await create(repoA, `${tag} L${i}`)).template!.templateId);
    }
    const results = await Promise.allSettled([create(repoA, `${tag} X1`), create(repoB, `${tag} X2`, other)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('SUPPLIER_TEXT_TEMPLATE_LIMIT');
    expect(await active()).toBe(SUPPLIER_TEXT_LIMITS.activeTemplates);
    for (const r of results) if (r.status === 'fulfilled') made.push(r.value.template!.templateId);
    for (const id of made) await repoA.remove({ ...base(admin), templateId: id, expectedVersion: 1 });
    expect(await active()).toBe(1);
  });
});

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import type { PerformanceQueryTelemetryService } from '../../performance/performance-query-telemetry.service';
import { PgOnecMatchingRepository } from './adapters/pg-onec-matching-repository';
import { PgOnecRepository } from './adapters/pg-onec-repository';
import { OnecMatchingService } from './application/onec-matching.service';
import type { OnecRuntimeConfigService } from './onec-runtime-config.service';

const suite = process.env.ONEC_AGENT_DOCKER_TEST === 'true' ? describe : describe.skip;
const runtime = { get: () => ({ enabled: true }), requireEnabled: () => undefined } as unknown as OnecRuntimeConfigService;

suite('1C matching report (E3c) — isolated PostgreSQL', () => {
  const schema = `e2e_onec_match_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let db: DatabaseService;
  let service: OnecMatchingService;

  beforeAll(async () => {
    const [container] = JSON.parse(execFileSync('docker', ['inspect', 'erp_test-postgresdb-1'], { encoding: 'utf8' }));
    const env = Object.fromEntries(container.Config.Env.map((entry: string) => { const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)]; }));
    const network = Object.values(container.NetworkSettings.Networks)[0] as { IPAddress: string };
    const url = new URL(`postgresql://${network.IPAddress}:5432/${env.POSTGRES_DB ?? 'erpdb'}`);
    url.username = env.POSTGRES_USER;
    url.password = env.POSTGRES_PASSWORD;
    // pg_trgm lives in public; keep it on the path for similarity().
    url.searchParams.set('options', `-c search_path=${schema},public,pg_catalog -c jit=off`);
    pool = new Pool({ connectionString: url.toString(), max: 4 });
    await pool.query(`CREATE SCHEMA ${schema}; SET search_path = ${schema}, public;
      CREATE TABLE users(user_id bigint PRIMARY KEY, username text);
      CREATE TABLE clients(client_id bigint PRIMARY KEY, client_name citext, ref_key_1c uuid);
      CREATE TABLE client_phones(phone_id bigserial PRIMARY KEY, client_id bigint, phone_number text);
      CREATE TABLE suppliers(supplier_id smallint PRIMARY KEY, supplier_name varchar, ref_key_1c uuid);`);
    for (const file of ['193_onec_agent_foundation.sql', '196_onec_agent_commands.sql', '198_onec_etl.sql', '200_onec_etl_snapshots_revocation.sql']) {
      await pool.query(`SET search_path = ${schema}, public; ${readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), 'utf8')}`);
    }
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(), DATABASE_QUERY_TIMEOUT_MS: 20000, DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 4, DATABASE_SSL: false };
    db = new DatabaseService(
      { get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv, true>,
      { measure: <T>(_sql: string, op: () => Promise<T>) => op() } as PerformanceQueryTelemetryService,
    );
    service = new OnecMatchingService(new PgOnecMatchingRepository(db), new PgOnecRepository(db), runtime);
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

  const K = { a: randomUUID(), b: randomUUID(), c: randomUUID(), d: randomUUID(), e: randomUUID(), f: randomUUID() };
  const run = randomUUID();
  const mirror = (entity: string, key: string, data: Record<string, unknown>, deleted = false) =>
    pool.query(
      `INSERT INTO ${schema}.onec_etl_mirror_rows (source_id, entity_code, source_key, deleted, data, row_hash, first_seen_run, last_run_id)
       VALUES (1, $1, $2, $3, $4::jsonb, 'h', $5, $5)`,
      [entity, key, deleted, JSON.stringify(data), run],
    );

  beforeEach(async () => {
    await pool.query(`SET search_path = ${schema}, public;
      TRUNCATE onec_etl_mirror_rows, clients, client_phones, suppliers, onec_agents, onec_sources RESTART IDENTITY CASCADE;
      INSERT INTO onec_sources (code, display_name) VALUES ('a', 'Тест');
      INSERT INTO onec_agents (agent_id, source_id, site_id, display_name) VALUES ('agent-a', 1, 's', 'E2E');
      INSERT INTO clients VALUES (1, 'ТОО «Мебель-Плюс»', NULL), (2, 'Иванов Сергей', NULL), (3, 'Иванов  Сергей', NULL), (4, 'Ромашка', '${K.d}'), (5, 'Совсем другой', NULL), (6, 'Мебельный центр', NULL);
      INSERT INTO client_phones (client_id, phone_number) VALUES (5, '8 701 555 44 33'), (6, '87019998877-123');
      INSERT INTO suppliers VALUES (1, 'ИП Лесторг', NULL);`);
    await mirror('counterparties', K.a, { Code: '001', Description: 'Мебель Плюс ТОО', Покупатель: true, Поставщик: false, IsFolder: false, ИдентификационныйНомер: '123456789012' });
    await mirror('counterparties', K.b, { Code: '002', Description: 'Иванов Сергей', Покупатель: true, IsFolder: false });
    await mirror('counterparties', K.c, { Code: '003', Description: 'Лесторг', Покупатель: false, Поставщик: true, IsFolder: false });
    await mirror('counterparties', K.d, { Code: '004', Description: 'ООО Ромашка-2', Покупатель: true, IsFolder: false });
    await mirror('counterparties', K.e, { Code: '005', Description: 'Мебельный центрр', Покупатель: true, IsFolder: false });
    await mirror('counterparties', K.f, { Code: '006', Description: 'Незнакомец', Покупатель: true, IsFolder: false });
    await mirror('counterparties', randomUUID(), { Description: 'Группа', IsFolder: true });
    await mirror('counterparty_phones', `["${K.f}",1]`, { Ref_Key: K.f, LineNumber: 1, Тип: 'Телефон', Представление: '+7 (701) 555-44-33' });
  });

  it('matches by 1C key, normalized name (legal forms, quotes, spaces) and phone; flags ambiguity; suggests similar names', async () => {
    const report = await service.counterparties({ agentId: 'agent-a', limit: '50' });
    expect(report.summary).toMatchObject({ total: 6, buyers: 5, suppliers: 1, matched: 4, ambiguous: 1, unmatched: 1, byRefKey: 1, byPhone: 1 });
    const byCode = Object.fromEntries(report.rows.map((row) => [row.code, row]));
    expect(byCode['001']).toMatchObject({ status: 'matched', bin: '123456789012', matches: [{ kind: 'client', id: 1, by: ['name'] }] });
    expect(byCode['002'].status).toBe('ambiguous'); // two ERP clients normalize to the same name
    expect(byCode['003'].matches).toEqual([{ kind: 'supplier', id: 1, name: 'ИП Лесторг', by: ['name'] }]);
    expect(byCode['004'].matches).toEqual([{ kind: 'client', id: 4, name: 'Ромашка', by: ['ref_key'] }]);
    expect(byCode['006'].matches).toEqual([{ kind: 'client', id: 5, name: 'Совсем другой', by: ['phone'] }]);
    expect(byCode['005'].status).toBe('unmatched');
    if (report.suggestionsAvailable) expect(byCode['005'].suggestions[0]).toMatchObject({ kind: 'client', id: 6, name: 'Мебельный центр' });
    expect(report.rows.some((row) => row.name === 'Группа')).toBe(false);
  });

  it('filters by status, role and search, and pages', async () => {
    expect((await service.counterparties({ agentId: 'agent-a', status: 'unmatched' })).rows.map((r) => r.code)).toEqual(['005']);
    expect((await service.counterparties({ agentId: 'agent-a', role: 'supplier' })).rows.map((r) => r.code)).toEqual(['003']);
    expect((await service.counterparties({ agentId: 'agent-a', search: '1234567890' })).rows.map((r) => r.code)).toEqual(['001']);
    const page = await service.counterparties({ agentId: 'agent-a', limit: '2', offset: '2' });
    expect([page.total, page.rows.length]).toEqual([6, 2]);
    const past = await service.counterparties({ agentId: 'agent-a', limit: '2', offset: '6' });
    expect([past.total, past.rows.length]).toEqual([6, 0]);
    for (const bad of [{ limit: '1.5' }, { offset: 'Infinity' }, { offset: '-1' }, { limit: '1e3' }]) {
      await expect(service.counterparties({ agentId: 'agent-a', ...bad })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });

  it('keeps Kazakh letters: different names never collapse into one', async () => {
    await pool.query(`INSERT INTO ${schema}.clients VALUES (10, 'Ғанат', NULL)`);
    await mirror('counterparties', randomUUID(), { Code: '010', Description: 'Қанат', Покупатель: true, IsFolder: false });
    const row = (await service.counterparties({ agentId: 'agent-a', search: 'Қанат' })).rows[0];
    expect(row.status).toBe('unmatched');
  });

  it('distributes items by category and type with price and stock presence (folders excluded)', async () => {
    const cat = randomUUID();
    const items = [randomUUID(), randomUUID(), randomUUID()];
    await mirror('item_categories', cat, { Description: 'ПЛЕНКА ПВХ', ТипНоменклатурыПоУмолчанию: 'Запас' });
    await mirror('items', items[0], { КатегорияНоменклатуры_Key: cat, ТипНоменклатуры: 'Запас', IsFolder: false });
    await mirror('items', items[1], { КатегорияНоменклатуры_Key: cat, ТипНоменклатуры: 'Услуга', IsFolder: false }, true);
    await mirror('items', items[2], { КатегорияНоменклатуры_Key: '00000000-0000-0000-0000-000000000000', ТипНоменклатуры: 'Запас', IsFolder: false });
    await mirror('items', randomUUID(), { IsFolder: true });
    await mirror('item_prices', 'p1', { Номенклатура_Key: items[0], Цена: 10 });
    await mirror('items', randomUUID(), { КатегорияНоменклатуры_Key: cat, ТипНоменклатуры: 'Запас', IsFolder: false });
    await pool.query(`UPDATE ${schema}.onec_etl_mirror_rows SET missing_in_source_at = now() WHERE entity_code = 'items' AND source_key NOT IN ($1, $2, $3) AND NOT (data->>'IsFolder')::boolean`, items);
    await mirror('stock_balances', 's1', { Номенклатура_Key: items[0], КоличествоBalance: -1.5 });
    const report = await service.itemDistribution('agent-a');
    expect(report.total).toBe(3);
    expect(report.categories[0]).toMatchObject({ categoryName: 'ПЛЕНКА ПВХ', defaultType: 'Запас', total: 2, deleted: 1, missing: 1, withPrice: 1, withStock: 1 });
    expect(report.categories[0].byType).toEqual(expect.arrayContaining([{ type: 'Запас', total: 1 }, { type: 'Услуга', total: 1 }]));
    expect(report.categories[1]).toMatchObject({ categoryName: null, total: 1 });
  });
});

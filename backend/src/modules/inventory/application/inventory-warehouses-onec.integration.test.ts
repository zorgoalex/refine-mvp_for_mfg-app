import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { OnecCatalogReader } from '../../onec-agent/onec-catalog-reader';
import { OnecRuntimeConfigService } from '../../onec-agent/onec-runtime-config.service';
import { InventoryService } from './inventory.service';

// Склады с ключом 1С через настоящий InventoryService, настоящий OnecCatalogReader и пул
// из ОДНОГО соединения (code review R2): чтение зеркала внутри транзакции команды обязано
// идти через её клиент — иначе команда ждёт второе соединение до таймаута.
// Только собственная одноразовая БД film_catalog_it_*.
const url = process.env.FILM_CATALOG_TEST_DATABASE_URL;

describe.skipIf(!url)('warehouses with 1C keys — InventoryService, real reader, pool of one connection', { timeout: 60000 }, () => {
  let database: DatabaseService;
  let watcher: Client;
  let service: InventoryService;
  let admin: CurrentUser;
  const tag = 'E2E-Тест-1С-склады-' + randomUUID().slice(0, 8);
  const mirror = { a: randomUUID(), b: randomUUID(), group: randomUUID() };
  const ctx = (key = randomUUID()) => ({ currentUser: admin, requestId: `req-${randomUUID()}`, idempotencyKey: key });

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
    if (!dbName.startsWith('film_catalog_it_')) throw new Error(`owned film_catalog_it_* database required (got ${dbName})`);
    watcher = new Client({ connectionString: url });
    await watcher.connect();
    const role = await watcher.query<{ role_id: number }>('SELECT min(role_id) AS role_id FROM roles');
    const actorId = Number((await watcher.query<{ user_id: string }>(
      `INSERT INTO users (username, email, password_hash, role_id, full_name)
       VALUES ($1, $2, 'test-hash', $3, $4) RETURNING user_id`,
      [`${tag}-admin`, `${randomUUID()}@example.invalid`, role.rows[0].role_id, `${tag} admin`],
    )).rows[0].user_id);
    admin = { id: String(actorId), username: `${tag}-admin`, role: 'admin', roleId: role.rows[0].role_id, permissions: ['inventory.view', 'inventory.manage'] };
    const source = Number((await watcher.query<{ source_id: string }>(
      "INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id",
      [`it-${randomUUID().slice(0, 8)}`, `${tag} база`],
    )).rows[0].source_id);
    const row = (key: string, name: string, kind: string) => [source, key, JSON.stringify({ Ref_Key: key, Code: `IT-${name.length}`, Description: name, DeletionMark: false, ТипСтруктурнойЕдиницы: kind })];
    for (const [key, name, kind] of [[mirror.a, `${tag} Цех А`, 'Склад'], [mirror.b, `${tag} Цех Б`, 'Склад'], [mirror.group, `${tag} Группа`, 'МагазинГруппаСкладов']] as const) {
      await watcher.query(
        `INSERT INTO onec_etl_mirror_rows (source_id, entity_code, source_key, deleted, data, row_hash, first_seen_run, last_run_id)
         VALUES ($1, 'warehouses', $2, false, $3::jsonb, md5($3::text), gen_random_uuid(), gen_random_uuid())`,
        row(key, name, kind),
      );
    }
    const config = new ConfigService<BackendEnv, true>({
      DATABASE_URL: url, DATABASE_POOL_MIN: 1, DATABASE_POOL_MAX: 1, DATABASE_SSL: false, DATABASE_QUERY_TIMEOUT_MS: 5000,
      BACKEND_INVENTORY_ENABLED: true, BACKEND_ENABLE_ONEC_AGENT: true, ONEC_CLIENT_CERT_HEADER: 'x-client-cert',
    });
    const telemetry = { measure: (_text: string, run: () => Promise<unknown>) => run() };
    database = new DatabaseService(config, telemetry as never);
    await database.query("SELECT set_config('app.user_id', $1, false)", [String(actorId)]);
    service = new InventoryService(database, config, new OnecCatalogReader(database, new OnecRuntimeConfigService(config)));
  });

  afterAll(async () => {
    await database?.onModuleDestroy();
    await watcher?.end();
  });

  it('lists only 1C warehouses of type «Склад»', async () => {
    const onec = await service.listOnecWarehouses(admin);
    expect(onec.available).toBe(true);
    const ours = onec.items.filter((item) => item.name.startsWith(tag)).map((item) => item.name).sort();
    expect(ours).toEqual([`${tag} Цех А`, `${tag} Цех Б`]);
  });

  it('creates with a mirror key inside the one-connection pool, rejects an unknown key, and replays', async () => {
    const key = randomUUID();
    const created = await service.createWarehouse(ctx(key), { name: `${tag} А`, refKey1c: mirror.a.toUpperCase(), workshopId: null, responsibleEmployeeId: null });
    expect(created).toMatchObject({ refKey1c: mirror.a, onecStatus: 'linked', onecName: `${tag} Цех А` });
    expect(await service.createWarehouse(ctx(key), { name: `${tag} А`, refKey1c: mirror.a.toUpperCase(), workshopId: null, responsibleEmployeeId: null }))
      .toEqual(created);
    await expect(service.createWarehouse(ctx(), { name: `${tag} Чужой`, refKey1c: randomUUID(), workshopId: null, responsibleEmployeeId: null }))
      .rejects.toMatchObject({ statusCode: 422, code: 'WAREHOUSE_1C_NOT_FOUND' });
    await expect(service.createWarehouse(ctx(), { name: `${tag} Группа`, refKey1c: mirror.group, workshopId: null, responsibleEmployeeId: null }))
      .rejects.toMatchObject({ statusCode: 422, code: 'WAREHOUSE_1C_NOT_FOUND' });
  });

  it('syncs the remaining 1C warehouse inside the one-connection pool; a replay returns the same result', async () => {
    const key = randomUUID();
    const result = await service.syncWarehousesFromOnec(ctx(key));
    const ours = result.created.filter((row) => row.name.startsWith(tag));
    expect(ours.map((row) => [row.name, row.refKey1c, row.onecStatus])).toEqual([[`${tag} Цех Б`, mirror.b, 'linked']]);
    expect(await service.syncWarehousesFromOnec(ctx(key))).toEqual(result);
    const list = await service.listWarehouses(admin, true);
    expect(list.filter((row) => row.name.startsWith(tag)).map((row) => row.onecStatus)).toEqual(['linked', 'linked']);
  });
});

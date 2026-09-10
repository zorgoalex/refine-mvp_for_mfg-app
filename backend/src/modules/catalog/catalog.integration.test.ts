import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import type { TransactionClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import { CatalogService } from './catalog.service';
import type { CatalogInput } from './catalog.validation';

const url = process.env.ERP_CATALOG_TEST_DATABASE_URL;
class FixtureDatabase extends DatabaseService {
  failOutbox = false;
  readonly tx: TransactionClient;
  constructor(readonly client: PoolClient) {
    super(new ConfigService<BackendEnv, true>({ DATABASE_QUERY_TIMEOUT_MS: 10000 }), {} as never);
    this.tx = { raw: client, query: this.query.bind(this) };
  }
  override async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) {
    if (this.failOutbox && sql.includes('INSERT INTO outbox_events')) await this.client.query('SELECT 1/0');
    return this.client.query<T>(sql, [...params]);
  }
  override async transaction<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    await this.client.query('SAVEPOINT catalog_command');
    try {
      const result = await fn(this.tx);
      await this.client.query('RELEASE SAVEPOINT catalog_command');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK TO SAVEPOINT catalog_command');
      await this.client.query('RELEASE SAVEPOINT catalog_command');
      throw error;
    }
  }
}

describe.skipIf(!url)('catalog real PostgreSQL, rollback-only fixtures', () => {
  let pool: Pool;
  let client: PoolClient;
  let db: FixtureDatabase;
  let service: CatalogService;
  let actor: CurrentUser;
  let input: CatalogInput;
  let prefix: string;
  beforeEach(async () => {
    expect(process.env.ERP_CATALOG_TEST_TARGET_ENV).toBe('backend-test');
    pool = new Pool({ connectionString: url, max: 1, statement_timeout: 10000, connectionTimeoutMillis: 5000 });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    const migration = readFileSync(new URL('../../../db/migrations/157_products_services_catalog.sql', import.meta.url), 'utf8');
    await client.query(migration);
    await client.query(migration);
    const serviceFields = readFileSync(new URL('../../../db/migrations/161_catalog_reference_service_fields.sql', import.meta.url), 'utf8');
    await client.query(serviceFields);
    await client.query(serviceFields);
    prefix = 'E2E-catalog-' + randomUUID();
    const user = (await client.query(`INSERT INTO users(username,email,password_hash,role_id) VALUES($1,$2,'E2E-NO-LOGIN',1) RETURNING user_id`, [prefix, prefix + '@example.invalid'])).rows[0];
    actor = { id: String(user.user_id), username: prefix, role: 'admin', roleId: 1, permissions: ['references.manage'] };
    const unitId = (await client.query('SELECT min(unit_id) AS id FROM units')).rows[0].id;
    expect(unitId).not.toBeNull();
    input = { name: prefix, sku: prefix, kind: 'service', unitId, basePrice: '12.50', description: '', isActive: true };
    db = new FixtureDatabase(client); service = new CatalogService(db);
  });
  afterEach(async () => { if (client) { await client.query('ROLLBACK'); client.release(); } await pool?.end(); });
  const key = () => randomUUID();
  it('persists service fields, preserves omitted values, sorts/searches and audits changes', async () => {
    const uuid = randomUUID();
    const first = await service.save(actor, { ...input, refKey1c: uuid.toUpperCase(), sortOrder: 200 }, key(), prefix);
    expect(first).toMatchObject({ refKey1c: uuid, sortOrder: 200, createdBy: actor.id, editedBy: actor.id, createdByName: actor.username, editedByName: actor.username });
    const second = await service.save(actor, { ...input, sku: null, sortOrder: -1 }, key(), prefix);
    expect((await service.list(actor, { q: prefix })).items.map(item => item.id)).toEqual([second.id, first.id]);
    expect((await service.list(actor, { q: uuid })).items.map(item => item.id)).toEqual([first.id]);
    const edited = await service.save(actor, { ...input, description: 'legacy client', expectedVersion: 1 }, key(), prefix, first.id);
    expect(edited).toMatchObject({ refKey1c: uuid, sortOrder: 200, version: 2 });
    const cleared = await service.save(actor, { ...input, refKey1c: null, sortOrder: 0, expectedVersion: 2 }, key(), prefix, first.id);
    expect(cleared).toMatchObject({ refKey1c: null, sortOrder: 0, version: 3 });
    const audit = (await client.query("SELECT diff_json FROM audit_log WHERE entity_type='catalog_item' AND entity_id=$1 AND request_id=$2 AND after_json->>'version'='3'", [String(first.id), prefix])).rows[0];
    expect(audit.diff_json).toMatchObject({ refKey1c: { from: uuid, to: null }, sortOrder: { from: 200, to: 0 } });
  });
  it('replays a pre-upgrade receipt unchanged and supplies defaults on new legacy creates', async () => {
    const legacyKey = key();
    const legacyResponse = { id: 123, name: 'E2E historical response' };
    const hash = createHash('sha256').update(JSON.stringify({ actorId: Number(actor.id), id: null, expectedVersion: null, input })).digest('hex');
    await client.query('INSERT INTO catalog_item_commands(idempotency_key,request_hash,actor_user_id,response_json) VALUES($1,$2,$3,$4)', [legacyKey, hash, actor.id, JSON.stringify(legacyResponse)]);
    expect(await service.save(actor, input, legacyKey, prefix)).toEqual(legacyResponse);
    expect(await service.save(actor, input, key(), prefix)).toMatchObject({ refKey1c: null, sortOrder: 100 });
  });
  it('keeps UUID unique across archived items and accepts multiple empty keys', async () => {
    const uuid = randomUUID();
    const first = await service.save(actor, { ...input, refKey1c: uuid, isActive: false }, key(), prefix);
    await expect(service.save(actor, { ...input, sku: null, refKey1c: uuid.toUpperCase() }, key(), prefix)).rejects.toMatchObject({ code: 'CATALOG_1C_KEY_CONFLICT' });
    const second = await service.save(actor, { ...input, sku: null, refKey1c: null }, key(), prefix);
    await service.save(actor, { ...input, sku: null, refKey1c: null }, key(), prefix);
    await expect(service.save(actor, { ...input, sku: null, refKey1c: uuid, expectedVersion: second.version }, key(), prefix, second.id)).rejects.toMatchObject({ code: 'CATALOG_1C_KEY_CONFLICT' });
    expect(await service.get(actor, first.id)).toMatchObject({ refKey1c: uuid, version: 1 });
    expect(await service.get(actor, second.id)).toMatchObject({ refKey1c: null, version: 1 });
  });
  async function counts() {
    return (await client.query(`SELECT
      (SELECT count(*)::int FROM catalog_items WHERE created_by=$1) AS items,
      (SELECT count(*)::int FROM catalog_item_commands WHERE actor_user_id=$1) AS commands,
      (SELECT count(*)::int FROM audit_log WHERE request_id=$2) AS audit,
      (SELECT count(*)::int FROM outbox_events WHERE payload_json->>'requestId'=$2) AS outbox`, [actor.id, prefix])).rows[0];
  }
  it('creates, edits, archives and restores, with one audit/outbox per change', async () => {
    let item = await service.save(actor, input, key(), prefix);
    expect(item).toMatchObject({ ...input, id: expect.any(Number), version: 1, currency: 'KZT' });
    item = await service.save(actor, { ...input, name: prefix + ' edited', expectedVersion: item.version }, key(), prefix, item.id);
    item = await service.save(actor, { ...input, isActive: false, expectedVersion: item.version }, key(), prefix, item.id);
    expect((await service.list(actor, { q: prefix })).total).toBe(0);
    expect((await service.list(actor, { q: prefix, active: 'false' })).items[0].id).toBe(item.id);
    expect(await service.get(actor, item.id)).toMatchObject({ isActive: false, version: 3 });
    await service.save(actor, { ...input, expectedVersion: 3 }, key(), prefix, item.id);
    expect(await counts()).toEqual({ items: 1, commands: 4, audit: 4, outbox: 4 });
    const audit = (await client.query('SELECT event,user_id,username,diff_json FROM audit_log WHERE request_id=$1 ORDER BY audit_id', [prefix])).rows;
    expect(audit.map(row => row.event).sort()).toEqual(['catalog.item_created', 'catalog.item_updated', 'catalog.item_archived', 'catalog.item_restored'].sort());
    expect(audit.find(row => row.event === 'catalog.item_archived')).toMatchObject({ user_id: actor.id, username: actor.username, diff_json: { isActive: { from: true, to: false } } });
  });
  it('replays create/update, rejects key reuse and stale version, suppresses no-op events', async () => {
    const firstKey = key();
    const item = await service.save(actor, input, firstKey, prefix);
    expect(await service.save(actor, input, firstKey, prefix)).toEqual(item);
    await expect(service.save(actor, { ...input, name: 'changed' }, firstKey, prefix)).rejects.toMatchObject({ code: 'CATALOG_KEY_CONFLICT' });
    const updateKey = key();
    const updated = await service.save(actor, { ...input, name: 'updated', expectedVersion: 1 }, updateKey, prefix, item.id);
    expect(await service.save(actor, { ...input, name: 'updated', expectedVersion: 1 }, updateKey, prefix, item.id)).toEqual(updated);
    await expect(service.save(actor, { ...input, expectedVersion: 1 }, key(), prefix, item.id)).rejects.toMatchObject({ code: 'CATALOG_VERSION_CONFLICT' });
    expect(await service.save(actor, { ...input, name: 'updated', expectedVersion: 2 }, key(), prefix, item.id)).toEqual(updated);
    expect(await counts()).toEqual({ items: 1, commands: 3, audit: 2, outbox: 2 });
  });
  it('never replays another actor response, nor accepts disabled/service actors', async () => {
    const firstKey = key();
    await service.save(actor, input, firstKey, prefix);
    const secondId = (await client.query(`INSERT INTO users(username,email,password_hash,role_id) VALUES($1,$2,'E2E-NO-LOGIN',1) RETURNING user_id`, [prefix + '-2', prefix + '-2@example.invalid'])).rows[0].user_id;
    await expect(service.save({ ...actor, id: String(secondId) }, input, firstKey, prefix)).rejects.toMatchObject({ code: 'CATALOG_KEY_CONFLICT' });
    await client.query('UPDATE users SET is_active=false WHERE user_id=$1', [actor.id]);
    await expect(service.save(actor, input, firstKey, prefix)).rejects.toMatchObject({ code: 'CATALOG_ACTOR_INVALID' });
    await client.query('UPDATE users SET is_active=true,is_service_account=true WHERE user_id=$1', [actor.id]);
    await expect(service.save(actor, input, firstKey, prefix)).rejects.toMatchObject({ code: 'CATALOG_ACTOR_INVALID' });
  });
  it('keeps archived SKU uniqueness, permits multiple null SKUs, checks units existence', async () => {
    const item = await service.save(actor, input, key(), prefix);
    await service.save(actor, { ...input, isActive: false, expectedVersion: 1 }, key(), prefix, item.id);
    await expect(service.save(actor, { ...input, sku: input.sku!.toUpperCase() }, key(), prefix)).rejects.toMatchObject({ code: 'CATALOG_SKU_CONFLICT' });
    await service.save(actor, { ...input, sku: null, basePrice: null }, key(), prefix);
    await service.save(actor, { ...input, sku: null, basePrice: '0' }, key(), prefix);
    await expect(service.save(actor, { ...input, unitId: 32767, sku: null }, key(), prefix)).rejects.toMatchObject({ code: 'CATALOG_UNIT_NOT_FOUND' });
    expect((await service.units(actor)).length).toBe(Number((await client.query('SELECT count(*) AS n FROM units')).rows[0].n));
    expect((await counts()).items).toBe(3);
  });
  it('escapes wildcard searches, preserves filtered total beyond last page', async () => {
    await service.save(actor, { ...input, name: prefix + '%_' }, key(), prefix);
    await service.save(actor, { ...input, sku: null, name: prefix + 'AA', kind: 'stock_item' }, key(), prefix);
    expect((await service.list(actor, { q: prefix + '%_' })).total).toBe(1);
    expect(await service.list(actor, { q: prefix, offset: '25' })).toEqual({ total: 2, items: [] });
    expect((await service.list(actor, { q: prefix, kind: 'stock_item' })).total).toBe(1);
  });
  it('rolls back item, audit and receipt if outbox write fails', async () => {
    db.failOutbox = true;
    await expect(service.save(actor, input, key(), prefix)).rejects.toThrow();
    expect(await counts()).toEqual({ items: 0, commands: 0, audit: 0, outbox: 0 });
    db.failOutbox = false;
    const item = await service.save(actor, input, key(), prefix);
    db.failOutbox = true;
    await expect(service.save(actor, { ...input, name: 'fail', expectedVersion: 1 }, key(), prefix, item.id)).rejects.toThrow();
    expect(await service.get(actor, item.id)).toEqual(item);
    expect(await counts()).toEqual({ items: 1, commands: 1, audit: 1, outbox: 1 });
  });
});

/** Explicit local-stage gate. All writes isolated in a disposable test schema. */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { parse as dotenvParse } from 'dotenv';
import { Client } from 'pg';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateEnv, type BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import { PerformanceQueryTelemetryService } from '../../performance/performance-query-telemetry.service';
import { RequestContextService } from '../../common/request-context/request-context.service';
import type { CurrentUser } from '../../permissions/current-user';
import { createGroups, type CadVariant } from '../../shared/cad-workspace';
import { CadClient } from './cad-client';
import { CadService } from './cad.service';

const enabled = process.env.CAD_INTEGRATION_TEST === 'true';
const d = enabled ? describe : describe.skip;
const schema = `test_cad_${randomUUID().replaceAll('-', '')}`;
const user: CurrentUser = { id: '1900000001', username: 'Тест CAD', role: 'superadmin', roleId: 1, permissions: ['orders.view', 'cad.view', 'cad.edit', 'cad.export', 'references.manage'] };

d('CAD real PostgreSQL + private CAD HTTP', () => {
  let admin: Client, db: DatabaseService, cad: CadService, remote: ChildProcess, temp: string, base: string;
  let working: CadVariant, original: CadVariant;
  const orderId = 1900000001, secondOrderId = 1900000002;
  beforeAll(async () => {
    // Never print the source env or URL. Fixed test-host allowlist rejects prod.
    const env = dotenvParse(readFileSync('/home/ovhtest/projects/erp_dev/.env'));
    const url = new URL(process.env.CAD_INTEGRATION_DATABASE_URL ?? env.HASURA_GRAPHQL_DATABASE_URL ?? '');
    if (!process.env.CAD_INTEGRATION_DATABASE_URL && url.hostname === 'postgresdb') url.hostname = '100.99.106.72';
    if (!['127.0.0.1', 'localhost', '100.99.106.72'].includes(url.hostname) || url.pathname !== '/erpdb') throw new Error('CAD test DB target denied');
    admin = new Client({ connectionString: url.toString() }); await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema},public`);
    for (const table of ['orders', 'order_details', 'audit_log', 'audit_log_related_entity', 'sheet_material_types', 'milling_types', 'edge_types']) {
      await admin.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    }
    await admin.query(readFileSync(join(__dirname, '../../../db/migrations/151_cad_workspaces.sql'), 'utf8'));
    await admin.query(`INSERT INTO sheet_material_types(sheet_material_type_id,name,material_type_id,unit_id,thickness_mm,width_mm,height_mm)
      VALUES(1900000001,'Тест МДФ',3,1,18,2800,2070)`);
    await admin.query(`INSERT INTO milling_types(milling_type_id,milling_type_name) VALUES(1,'Тест контур')`);
    await admin.query(`INSERT INTO edge_types(edge_type_id,edge_type_name) VALUES(1,'Тест обкат')`);
    for (const id of [orderId, secondOrderId]) {
      await admin.query(`INSERT INTO orders(order_id,order_name,client_id,order_status_id,payment_status_id,created_by,sheet_material_type_id,project_id)
        VALUES($1,$2,1,1,1,$1,1900000001,1900000001)`, [id, `Тест CAD ${id}`]);
      await admin.query(`INSERT INTO order_details(detail_id,order_id,detail_number,height,width,quantity,area,milling_type_id,edge_type_id,created_by,sheet_material_type_id)
        VALUES($1,$1,1,400,200,10,0.8,1,1,$1,1900000001)`, [id]);
    }
    url.searchParams.set('options', `-c search_path=${schema},public`);
    const config = new ConfigService<BackendEnv, true>(validateEnv({ NODE_ENV: 'test', DATABASE_URL: url.toString(), DATABASE_POOL_MAX: '3', DATABASE_QUERY_TIMEOUT_MS: '30000', JWT_SECRET: 'test-jwt-secret-'.repeat(4), JWT_REFRESH_SECRET: 'test-refresh-secret-'.repeat(4) }));
    db = new DatabaseService(config, new PerformanceQueryTelemetryService(config, new RequestContextService()));
    temp = mkdtempSync(join(tmpdir(), 'erp-cad-http-test-'));
    remote = spawn(process.env.CAD_TEST_PYTHON ?? 'python3', ['-u', '-c', `
import os,threading
from pathlib import Path
from http.server import ThreadingHTTPServer
from cad_service.server import CadServiceHandler
from cad_service.integration import IntegrationStore
CadServiceHandler.integration_store=IntegrationStore(Path(os.environ['CAD_TEST_ROOT']))
server=ThreadingHTTPServer(('127.0.0.1',0),CadServiceHandler)
threading.Thread(target=CadServiceHandler.integration_store.run,args=(threading.Event(),),daemon=True).start()
print(server.server_port,flush=True)
server.serve_forever()
`], { cwd: process.env.CAD_TEST_REPO ?? '/home/ovhtest/projects/erp_dev/worktrees/cad-integration-api', env: { ...process.env, CAD_TEST_ROOT: temp, CAD_ERP_API_TOKEN: 'e'.repeat(40), CAD_ERP_WORKSPACE: 'erp-test', CAD_ADMIN_API_TOKEN: 'a'.repeat(40) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CAD test server startup timeout')), 15000);
      remote.stdout!.once('data', data => { clearTimeout(timer); resolve(String(data).trim()); });
      remote.once('error', reject); remote.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('CAD test server exited')); });
    });
    if (!/^\d+$/.test(port)) throw new Error('Invalid CAD test port');
    base = `http://127.0.0.1:${port}`;
    const client = new CadClient(base, 'e'.repeat(40)); cad = new CadService(db, client, true);
    const catalog = await client.catalog(); const recipe = catalog.recipes.find(r => r.code === 'contour_only')!;
    const approval = await fetch(`${base}/api/v2/admin/approve`, { method: 'POST', headers: { Authorization: `Bearer ${'a'.repeat(40)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot_hash: recipe.snapshot_hash }) });
    expect(approval.ok).toBe(true);
    await cad.mapRecipe(user, 1, { code: recipe.code, version: recipe.version, parameters: {} }, 0, randomUUID());
  }, 45000);
  afterAll(async () => {
    cad?.onModuleDestroy(); await db?.onModuleDestroy();
    if (remote && remote.exitCode == null) { const done = new Promise<void>(resolve => remote.once('exit', () => resolve())); remote.kill('SIGTERM'); await done; }
    if (admin) { await admin.query('ROLLBACK'); await admin.query('SET search_path TO public'); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    if (temp) rmSync(temp, { recursive: true, force: true });
  });
  it('creates immutable original+working and idempotent audit/outbox', async () => {
    const key = randomUUID(); const result = await cad.create(user, orderId, key);
    expect(await cad.create(user, orderId, key)).toEqual(result);
    const work = await cad.workspace(user, orderId); expect(work.variants).toHaveLength(2);
    original = work.variants.find(v => v.kind === 'original')!; working = work.variants.find(v => v.kind === 'working')!;
    expect(original.sources[0].parts[0].thicknessMm).toBe(18);
    expect((await admin.query("SELECT count(*)::int n FROM cad_events WHERE event='cad.workspace.created'")).rows[0].n).toBe(1);
    expect((await admin.query('SELECT count(*)::int n FROM cad_events e JOIN audit_log a ON a.audit_id=e.audit_id')).rows[0].n).toBe(4);
    await expect(admin.query("UPDATE cad_variants SET data='{}' WHERE id=$1", [original.id])).rejects.toThrow('CAD_ORIGINAL_IMMUTABLE');
    await expect(admin.query("UPDATE cad_sources SET data='{}' WHERE id=$1", [original.sources[0].id])).rejects.toThrow('CAD_IMMUTABLE_SNAPSHOT');
  });
  it('saves mixed partial composition; enforces CAS and leaves original/order quantities', async () => {
    const second = await cad.source(user, secondOrderId, randomUUID());
    const groups = [...working.groups.map(g => ({ ...g, quantity: 4 })), ...createGroups([second], randomUUID).map(g => ({ ...g, quantity: 3 }))];
    const key = randomUUID(); const next = await cad.save(user, working.id, 1, groups, [...working.sources, second].map(s => s.id), key);
    expect(await cad.save(user, working.id, 1, groups, [...working.sources, second].map(s => s.id), key)).toEqual(next);
    await expect(cad.save(user, working.id, 1, groups, next.sources.map(s => s.id), randomUUID())).rejects.toMatchObject({ code: 'CAD_STALE_VERSION' });
    expect((await cad.workspace(user, orderId)).variants.find(v => v.id === original.id)).toEqual(original);
    expect((await admin.query('SELECT quantity FROM order_details WHERE detail_id=$1', [orderId])).rows[0].quantity).toBe(10);
    working = next;
  });
  it('refresh creates conflict, never silently trims or overwrites', async () => {
    await admin.query('UPDATE order_details SET quantity=2 WHERE detail_id=$1', [secondOrderId]);
    expect((await cad.sourceStatus(user, working.id)).find(s => s.orderId === secondOrderId)?.stale).toBe(true);
    const next = await cad.clone(user, working.id, 'Тест обновление', true, randomUUID());
    expect(next.groups.find(g => g.orderId === secondOrderId)?.quantity).toBe(3);
    await expect(cad.render(user, next.id, next.version, randomUUID())).rejects.toMatchObject({ code: 'CAD_COMPOSITION_INVALID' });
  });
  it('dispatches without browser, persists completion audit and exports exact archived revision', async () => {
    await cad.render(user, working.id, working.version, randomUUID());
    for (let i = 0; i < 50; i++) {
      await admin.query('UPDATE cad_runs SET next_attempt_at=now()'); await cad.tick();
      const result = await cad.run(user, working.id, working.version);
      if (result.run?.status === 'succeeded') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const rendered = await cad.run(user, working.id, working.version); expect(rendered.run?.status).toBe('succeeded');
    expect(rendered.job?.items).toHaveLength(2);
    const exporter = { ...user, id: '1900000003', username: 'Тест другой экспортёр' };
    const packageKey = randomUUID();
    await cad.requestPackage(exporter, working.id, working.version, packageKey);
    for (let i = 0; i < 20; i++) {
      await admin.query('UPDATE cad_runs SET next_attempt_at=now()'); await cad.tick();
      const result = await cad.run(user, working.id, working.version);
      if (result.run?.packageId || result.run?.lastError) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const packed = await cad.run(user, working.id, working.version); expect(packed.run?.packageId).toBeTruthy();
    const manifest = packed.job!.package_files.find(f => f.name === 'manifest.json')!;
    const response = await cad.download(user, packed.run!.id, manifest.id); const document = await response.json();
    expect(document.parts.map((p: { part: { quantity: number } }) => p.part.quantity)).toEqual([4, 3]);
    expect(document.parts.every((p: { source: { revision: number } }) => p.source.revision === 2)).toBe(true);
    expect((await admin.query("SELECT count(*)::int n FROM cad_events WHERE event='cad.package.completed'")).rows[0].n).toBe(1);
    expect((await admin.query("SELECT actor_id,request_id FROM cad_events WHERE event='cad.package.completed'")).rows[0]).toEqual({ actor_id: exporter.id, request_id: packageKey });
    await expect(cad.download({ ...user, permissions: ['orders.view', 'cad.view'] }, packed.run!.id, manifest.id)).rejects.toMatchObject({ statusCode: 403 });
  }, 25000);
  it('denies archived artifact and command replay when a source becomes inaccessible', async () => {
    const archived = await cad.run(user, working.id, working.version);
    expect(archived.run?.packageId).toBeTruthy();
    await admin.query('UPDATE orders SET delete_flag=true WHERE order_id=$1', [secondOrderId]);
    expect((await cad.run(user, working.id, 1)).run?.status).toBe('succeeded');
    await admin.query('UPDATE orders SET delete_flag=false WHERE order_id=$1', [secondOrderId]);
    const key = randomUUID(); await cad.clone(user, working.id, 'Тест повтор', false, key);
    await cad.save(user, working.id, working.version, working.groups.filter(g => g.orderId !== secondOrderId), working.sources.filter(s => s.orderId !== secondOrderId).map(s => s.id), randomUUID());
    const packageKey = randomUUID(); await cad.requestPackage(user, working.id, working.version, packageKey);
    expect((await admin.query(`SELECT DISTINCT s.order_id FROM cad_event_sources s JOIN cad_events e ON e.id=s.event_id
      WHERE e.event='cad.package.requested' AND e.request_id=$1 ORDER BY s.order_id`, [packageKey])).rows.map(r => Number(r.order_id))).toEqual([orderId, secondOrderId]);
    await admin.query('UPDATE orders SET delete_flag=true WHERE order_id=$1', [secondOrderId]);
    await expect(cad.clone(user, working.id, 'Тест повтор', false, key)).rejects.toThrow();
    await expect(cad.download(user, archived.run!.id, archived.run!.packageId!)).rejects.toThrow();
  });
});

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// «Переделка»: Hasura shows an order's stage marks of its current production round only.
const scriptPath = resolve(process.cwd(), 'ops/hasura/production-status-events-current-round.sh');
const metadataSnapshot = JSON.parse(readFileSync(resolve(process.cwd(), 'ops/hasura/metadata.json'), 'utf8'));

const ROUND_FILTER = {
  _or: [
    { order_id: { _is_null: true } },
    { order: { production_round: { _ceq: ['$', 'round_no'] } } },
  ],
};
const PREDICATE = { _exists: { _table: { schema: 'public', name: 'user_effective_permissions' }, _where: { user_id: { _eq: 'X-Hasura-User-Id' } } } };

type Permission = { columns: string | string[]; filter: unknown; allow_aggregations?: boolean };
type SelectPermission = { role: string; permission: Permission };

function snapshotPermissions(): SelectPermission[] {
  const root = metadataSnapshot.metadata ?? metadataSnapshot;
  const table = root.sources
    .flatMap((source: { tables: Array<{ table: { name: string }; select_permissions?: SelectPermission[] }> }) => source.tables)
    .find((entry: { table: { name: string } }) => entry.table.name === 'production_status_events');
  return table?.select_permissions ?? [];
}

function fakeHasura(initial: SelectPermission[], options: { bumpAfterExport?: boolean; withoutOrderRelationship?: boolean } = {}) {
  const state = { version: 3, permissions: JSON.parse(JSON.stringify(initial)) as SelectPermission[], bulkRequests: 0 };
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      const reply = (code: number, value: unknown) => {
        response.writeHead(code, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.headers['x-hasura-admin-secret'] !== 'test-secret') return reply(401, { error: 'no secret' });
      if (payload.type === 'export_metadata') {
        const exported = {
          resource_version: state.version,
          metadata: { version: 3, sources: [{ name: 'default', tables: [{
            table: { schema: 'public', name: 'production_status_events' },
            object_relationships: options.withoutOrderRelationship ? [] : [{ name: 'order', using: { foreign_key_constraint_on: 'order_id' } }],
            select_permissions: state.permissions,
          }] }] },
        };
        if (options.bumpAfterExport) state.version += 1;
        return reply(200, exported);
      }
      if (payload.type === 'bulk') {
        state.bulkRequests += 1;
        if (payload.resource_version !== state.version) return reply(409, { error: 'conflict' });
        const next = JSON.parse(JSON.stringify(state.permissions)) as SelectPermission[];
        for (const action of payload.args) {
          expect(action.args.table).toEqual({ schema: 'public', name: 'production_status_events' });
          const index = next.findIndex((entry) => entry.role === action.args.role);
          if (action.type === 'pg_drop_select_permission') next.splice(index, 1);
          else if (action.type === 'pg_create_select_permission') next.push({ role: action.args.role, permission: action.args.permission });
          else throw new Error(`unexpected ${action.type}`);
        }
        state.permissions = next;
        state.version += 1;
        return reply(200, payload.args.map(() => ({ message: 'success' })));
      }
      return reply(400, { error: `unexpected ${payload.type}` });
    });
  });
  return { server, state };
}

let running: Server | undefined;
afterEach(async () => {
  await new Promise<void>((done) => (running ? running.close(() => done()) : done()));
  running = undefined;
});

async function runScript(server: Server, args: string[] = []) {
  running = server;
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  return new Promise<{ code: number | null; output: string }>((done) => {
    const child = spawn('bash', [scriptPath, ...args], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HASURA_GRAPHQL_ENDPOINT: `http://127.0.0.1:${port}/v1/graphql`, HASURA_ADMIN_SECRET: 'test-secret' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => done({ code, output }));
  });
}

const live: SelectPermission[] = [
  { role: 'manager', permission: { columns: '*', filter: { _and: [{}, PREDICATE] }, allow_aggregations: true } },
  { role: 'packer', permission: { columns: ['event_id', 'order_id'], filter: { _and: [{}, PREDICATE] }, allow_aggregations: true } },
];

describe('production_status_events: current production round only', () => {
  it('the metadata snapshot carries the round condition for every role, inside the access predicates', () => {
    const permissions = snapshotPermissions();
    expect(permissions.length).toBe(8);
    for (const permission of permissions) {
      const filter = permission.permission.filter as { _and?: unknown[] };
      expect(filter._and?.[0], permission.role).toEqual(ROUND_FILTER);
      expect(JSON.stringify(filter._and?.[1]), permission.role).toContain('user_effective_permissions');
    }
  });

  it('sets the base filter only, keeping columns, aggregations and predicates, in one bulk request; a re-run changes nothing', async () => {
    const { server, state } = fakeHasura(live);
    const result = await runScript(server);
    expect(result.code, result.output).toBe(0);
    expect(state.bulkRequests).toBe(1);
    const byRole = Object.fromEntries(state.permissions.map((entry) => [entry.role, entry.permission]));
    expect(byRole.manager).toEqual({ columns: '*', filter: { _and: [ROUND_FILTER, PREDICATE] }, allow_aggregations: true });
    expect(byRole.packer).toEqual({ columns: ['event_id', 'order_id'], filter: { _and: [ROUND_FILTER, PREDICATE] }, allow_aggregations: true });
    running?.close();
    running = undefined;
    const again = fakeHasura(state.permissions);
    const second = await runScript(again.server);
    expect(second.code, second.output).toBe(0);
    expect(second.output).toContain('Nothing to change.');
    expect(again.state.bulkRequests).toBe(0);
  });

  it('--revert puts the open base filter back; --dry-run changes nothing', async () => {
    const applied = live.map((entry) => ({ ...entry, permission: { ...entry.permission, filter: { _and: [ROUND_FILTER, PREDICATE] } } }));
    const dry = fakeHasura(applied);
    const dryRun = await runScript(dry.server, ['--revert', '--dry-run']);
    expect(dryRun.code, dryRun.output).toBe(0);
    expect(dry.state.bulkRequests).toBe(0);
    running?.close();
    running = undefined;
    const { server, state } = fakeHasura(applied);
    const result = await runScript(server, ['--revert']);
    expect(result.code, result.output).toBe(0);
    for (const entry of state.permissions) expect(entry.permission.filter).toEqual({ _and: [{}, PREDICATE] });
  });

  it('refuses an unexpected base filter, a missing order relationship, and a concurrent metadata change (nothing applied)', async () => {
    const foreign = fakeHasura([{ role: 'manager', permission: { columns: '*', filter: { _and: [{ order_id: { _eq: 1 } }, PREDICATE] } } }]);
    const refused = await runScript(foreign.server);
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain('unexpected base filter');
    expect(foreign.state.bulkRequests).toBe(0);
    running?.close();
    running = undefined;
    const noRelationship = fakeHasura(live, { withoutOrderRelationship: true });
    const missing = await runScript(noRelationship.server);
    expect(missing.code).not.toBe(0);
    expect(missing.output).toContain("no object relationship 'order'");
    running?.close();
    running = undefined;
    const raced = fakeHasura(live, { bumpAfterExport: true });
    const conflict = await runScript(raced.server);
    expect(conflict.code).not.toBe(0);
    expect(conflict.output).toContain('409');
    expect(raced.state.permissions).toEqual(live);
  });
});

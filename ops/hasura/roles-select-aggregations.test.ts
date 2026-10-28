import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = resolve(process.cwd(), 'ops/hasura/roles-select-aggregations.sh');
const metadataSnapshot = JSON.parse(readFileSync(resolve(process.cwd(), 'ops/hasura/metadata.json'), 'utf8'));

type Permission = { columns: string[]; filter: unknown; allow_aggregations?: boolean };
type SelectPermission = { role: string; permission: Permission };

function rolesSelectPermissions(): SelectPermission[] {
  const root = metadataSnapshot.metadata ?? metadataSnapshot;
  const table = root.sources
    .flatMap((source: { tables: Array<{ table: { name: string; schema?: string }; select_permissions?: SelectPermission[] }> }) => source.tables)
    .find((entry: { table: { name: string; schema?: string } }) => entry.table.name === 'roles' && (entry.table.schema ?? 'public') === 'public');
  return table?.select_permissions ?? [];
}

// A minimal Hasura metadata API: export_metadata v2 and bulk with resource_version checks.
function fakeHasura(initial: SelectPermission[], options: { bumpAfterExport?: boolean; extraTables?: Record<string, SelectPermission[]>; paddingTables?: number } = {}) {
  const state = {
    version: 7,
    roles: JSON.parse(JSON.stringify(initial)) as SelectPermission[],
    extra: JSON.parse(JSON.stringify(options.extraTables ?? {})) as Record<string, SelectPermission[]>,
    other: { role: 'viewer', permission: { columns: ['id'], filter: { id: { _eq: 1 } } } },
    bulkRequests: 0,
  };
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
          metadata: { version: 3, sources: [{ name: 'default', tables: [
            { table: { schema: 'public', name: 'roles' }, select_permissions: state.roles },
            { table: { schema: 'public', name: 'other' }, select_permissions: [state.other] },
            ...Object.entries(state.extra).map(([name, permissions]) => ({ table: { schema: 'public', name }, select_permissions: permissions })),
            // A live export is ~300 KB: padding makes the export larger than one environment string may be (128 KB).
            ...Array.from({ length: options.paddingTables ?? 0 }, (_, index) => ({
              table: { schema: 'public', name: `padding_${index}` },
              select_permissions: [{ role: 'manager', permission: { columns: Array.from({ length: 20 }, (__, c) => `column_number_${c}`), filter: {} } }],
            })),
          ] }] },
        };
        // Someone edits metadata right after our read.
        if (options.bumpAfterExport) state.version += 1;
        return reply(200, exported);
      }
      if (payload.type === 'bulk') {
        state.bulkRequests += 1;
        if (payload.resource_version !== state.version) return reply(409, { error: 'conflict', code: 'conflict' });
        const tables: Record<string, SelectPermission[]> = JSON.parse(JSON.stringify({ roles: state.roles, ...state.extra }));
        for (const action of payload.args) {
          expect(action.args.table.schema).toBe('public');
          const next = tables[action.args.table.name];
          expect(next, action.args.table.name).toBeDefined();
          const index = next.findIndex((entry) => entry.role === action.args.role);
          if (action.type === 'pg_drop_select_permission') next.splice(index, 1);
          else if (action.type === 'pg_create_select_permission') next.push({ role: action.args.role, permission: action.args.permission });
          else throw new Error(`unexpected ${action.type}`);
        }
        const { roles, ...extra } = tables;
        state.roles = roles;
        state.extra = extra;
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
  { role: 'manager', permission: { columns: ['role_id', 'role_name'], filter: {} } },
  { role: 'viewer', permission: { columns: ['role_id'], filter: { is_active: { _eq: true } } } },
];

describe('roles select aggregations', () => {
  it('lets every role that reads roles also count them in the metadata snapshot', () => {
    const permissions = rolesSelectPermissions();
    expect(permissions.map((p) => p.role).sort()).toEqual(['erp_admin', 'manager', 'operator', 'superadmin', 'top_manager', 'viewer']);
    for (const permission of permissions) {
      expect(permission.permission.allow_aggregations, permission.role).toBe(true);
      // Access groups 0Б: the open role filter is wrapped in the user's effective-permission predicate.
      const filter = permission.permission.filter as { _and?: unknown[] };
      expect(filter._and?.[0], permission.role).toEqual({});
      expect(JSON.stringify(filter._and?.[1]), permission.role).toContain('user_effective_permissions');
    }
  });

  it('adds allow_aggregations only, keeping the live columns and filters, in one bulk request', async () => {
    const { server, state } = fakeHasura(live);
    const result = await runScript(server);
    expect(result.code, result.output).toBe(0);
    expect(state.bulkRequests).toBe(1);
    const byRole = Object.fromEntries(state.roles.map((entry) => [entry.role, entry.permission]));
    expect(byRole.manager).toEqual({ columns: ['role_id', 'role_name'], filter: {}, allow_aggregations: true });
    expect(byRole.viewer).toEqual({ columns: ['role_id'], filter: { is_active: { _eq: true } }, allow_aggregations: true });
    expect(state.other).toEqual({ role: 'viewer', permission: { columns: ['id'], filter: { id: { _eq: 1 } } } });
  });

  it('applies nothing when metadata changed after it was read (409) and fails', async () => {
    const { server, state } = fakeHasura(live, { bumpAfterExport: true });
    const result = await runScript(server);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('409 conflict');
    expect(state.roles).toEqual(live);
  });

  it('dry run changes nothing; a second run is a no-op; --revert restores the previous state', async () => {
    const dry = fakeHasura(live);
    const dryResult = await runScript(dry.server, ['--dry-run']);
    expect(dryResult.code, dryResult.output).toBe(0);
    expect(dryResult.output).toContain('Dry run: 2 permission(s)');
    expect(dry.state.bulkRequests).toBe(0);
    await new Promise<void>((done) => dry.server.close(() => done()));
    running = undefined;

    const applied = live.map((entry) => ({ ...entry, permission: { ...entry.permission, allow_aggregations: true } }));
    const again = fakeHasura(applied);
    const againResult = await runScript(again.server);
    expect(againResult.output).toContain('Nothing to change.');
    expect(again.state.bulkRequests).toBe(0);
    await new Promise<void>((done) => again.server.close(() => done()));
    running = undefined;

    const revert = fakeHasura(applied);
    const revertResult = await runScript(revert.server, ['--revert']);
    expect(revertResult.code, revertResult.output).toBe(0);
    const byRole = Object.fromEntries(revert.state.roles.map((entry) => [entry.role, entry.permission]));
    expect(byRole.manager).toEqual({ columns: ['role_id', 'role_name'], filter: {}, allow_aggregations: false });
    expect(byRole.viewer).toEqual({ columns: ['role_id'], filter: { is_active: { _eq: true } }, allow_aggregations: false });
  });

  it('the reference lists that count rows can be counted by every role that reads them (28.10)', () => {
    const root = metadataSnapshot.metadata ?? metadataSnapshot;
    const tables = root.sources.flatMap((source: { tables: Array<{ table: { name: string }; select_permissions?: SelectPermission[] }> }) => source.tables);
    for (const name of ['movements_statuses', 'material_transaction_types', 'transaction_direction']) {
      const permissions = tables.find((entry: { table: { name: string } }) => entry.table.name === name)?.select_permissions ?? [];
      expect(permissions.length, name).toBeGreaterThan(0);
      for (const permission of permissions) expect(permission.permission.allow_aggregations, `${name}/${permission.role}`).toBe(true);
    }
  });

  it('--tables: refuses a table that is not tracked and a malformed list, changing nothing', async () => {
    const missing = fakeHasura(live);
    const missingResult = await runScript(missing.server, ['--tables', 'roles,no_such_table']);
    expect(missingResult.code).not.toBe(0);
    expect(missingResult.output).toContain('not tracked: public.no_such_table');
    expect(missing.state.bulkRequests).toBe(0);
    await new Promise<void>((done) => missing.server.close(() => done()));
    running = undefined;

    const malformed = fakeHasura(live);
    const malformedResult = await runScript(malformed.server, ['--tables', 'roles;drop']);
    expect(malformedResult.code).toBe(2);
    expect(malformed.state.bulkRequests).toBe(0);
  });

  it('reads a live-size export (larger than one environment string) and changes several tables in one bulk request', async () => {
    const reference = [{ role: 'manager', permission: { columns: ['direction_id'], filter: { _and: [{}, { user: 'predicate' }] } } }];
    const { server, state } = fakeHasura(live, {
      extraTables: { transaction_direction: reference, movements_statuses: reference },
      paddingTables: 1200,
    });
    const result = await runScript(server, ['--tables', 'transaction_direction,movements_statuses']);
    expect(result.code, result.output).toBe(0);
    expect(state.bulkRequests).toBe(1);
    for (const name of ['transaction_direction', 'movements_statuses']) {
      expect(state.extra[name], name).toEqual([{ role: 'manager', permission: { ...reference[0].permission, allow_aggregations: true } }]);
    }
    expect(state.roles).toEqual(live);
  });

  it('--only: a rollback turns off exactly the given permissions; one added later (manager2) keeps its aggregations', async () => {
    const applied = { columns: ['direction_id'], filter: {}, allow_aggregations: true };
    const { server, state } = fakeHasura(live, {
      extraTables: {
        transaction_direction: [
          { role: 'manager', permission: { ...applied } },
          { role: 'operator', permission: { ...applied } },
          { role: 'manager2', permission: { ...applied } },
        ],
      },
    });
    const result = await runScript(server, ['--revert', '--tables', 'transaction_direction', '--only', 'transaction_direction/manager,transaction_direction/operator']);
    expect(result.code, result.output).toBe(0);
    const byRole = Object.fromEntries(state.extra.transaction_direction.map((entry) => [entry.role, entry.permission.allow_aggregations]));
    expect(byRole).toEqual({ manager: false, operator: false, manager2: true });
  });

  it('--only: refuses a pair without a permission or outside --tables, changing nothing', async () => {
    const { server, state } = fakeHasura(live, { extraTables: { transaction_direction: [{ role: 'manager', permission: { columns: ['direction_id'], filter: {} } }] } });
    const result = await runScript(server, ['--tables', 'transaction_direction', '--only', 'transaction_direction/manager,transaction_direction/nobody']);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('no select permission for transaction_direction/nobody');
    expect(state.bulkRequests).toBe(0);
    await new Promise<void>((done) => server.close(() => done()));
    running = undefined;

    const outside = fakeHasura(live);
    const outsideResult = await runScript(outside.server, ['--tables', 'roles', '--only', 'transaction_direction/manager']);
    expect(outsideResult.code).not.toBe(0);
    expect(outsideResult.output).toContain('not in --tables');
    expect(outside.state.bulkRequests).toBe(0);
  });
});

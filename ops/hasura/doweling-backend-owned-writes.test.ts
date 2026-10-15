import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = resolve(process.cwd(), 'ops/hasura/doweling-backend-owned-writes.sh');
const reference = JSON.parse(readFileSync(resolve(process.cwd(), 'ops/hasura/doweling-writes-before-revoke.json'), 'utf8')).permissions as Record<
  string,
  Partial<Record<Op, Permission[]>>
>;
const snapshot = JSON.parse(readFileSync(resolve(process.cwd(), 'ops/hasura/metadata.json'), 'utf8'));

type Op = 'insert' | 'update' | 'delete';
type Permission = { role: string; permission: Record<string, unknown>; comment?: string };
type TableState = Partial<Record<`${Op}_permissions`, Permission[]>> & { select_permissions?: Permission[] };
type Live = Record<string, TableState>;

const TABLES = ['doweling_orders', 'order_doweling_links'];

function grantedLive(): Live {
  const live: Live = {};
  for (const table of TABLES) {
    live[table] = { select_permissions: [{ role: 'manager', permission: { columns: '*', filter: {} } }] };
    for (const [op, permissions] of Object.entries(reference[table])) {
      // Hasura may export another role order and an empty comment: still the known state.
      live[table][`${op as Op}_permissions`] = JSON.parse(JSON.stringify(permissions)).reverse().map((p: Permission) => ({ ...p, comment: p.comment ?? '' }));
    }
  }
  return live;
}

function revokedLive(): Live {
  return Object.fromEntries(TABLES.map((table) => [table, { select_permissions: [{ role: 'manager', permission: { columns: '*', filter: {} } }] }]));
}

// A minimal Hasura metadata API: export_metadata v2 and bulk with resource_version checks.
function fakeHasura(initial: Live, options: { bumpAfterExport?: boolean; failBulk?: boolean; padding?: number } = {}) {
  const state = { version: 7, tables: JSON.parse(JSON.stringify(initial)) as Live, bulkRequests: 0 };
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
            ...TABLES.map((name) => ({ table: { schema: 'public', name }, ...state.tables[name] })),
            { table: { schema: 'public', name: 'other' }, insert_permissions: [{ role: 'viewer', permission: { columns: '*', check: {} } }] },
            // The real metadata after access groups 0Б is megabytes.
            ...(options.padding ? [{ table: { schema: 'public', name: 'padding' }, comment: 'x'.repeat(options.padding) }] : []),
          ] }] },
        };
        if (options.bumpAfterExport) state.version += 1;
        return reply(200, exported);
      }
      if (payload.type === 'bulk') {
        state.bulkRequests += 1;
        if (options.failBulk) return reply(500, { code: 'unexpected', error: 'internal', internal: { url: 'postgres://erp:s3cr3t@db/erp' } });
        if (payload.resource_version !== state.version) return reply(409, { error: 'conflict', code: 'conflict' });
        const next = JSON.parse(JSON.stringify(state.tables)) as Live;
        for (const action of payload.args) {
          const match = /^pg_(drop|create)_(insert|update|delete)_permission$/.exec(action.type);
          if (!match) throw new Error(`unexpected ${action.type}`);
          const table = next[action.args.table.name];
          expect(table, action.args.table.name).toBeDefined();
          const key = `${match[2] as Op}_permissions` as const;
          const list = (table[key] ??= []);
          if (match[1] === 'drop') list.splice(list.findIndex((entry) => entry.role === action.args.role), 1);
          else list.push({ role: action.args.role, permission: action.args.permission, ...(action.args.comment ? { comment: action.args.comment } : {}) });
          if (list.length === 0) delete table[key];
        }
        state.tables = next;
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

async function stop(server: Server) {
  await new Promise<void>((done) => server.close(() => done()));
  running = undefined;
}

describe('doweling backend-owned Hasura writes', () => {
  it('the release snapshot has no doweling write permissions; reads stay', () => {
    const tables = (snapshot.metadata ?? snapshot).sources.flatMap((source: { tables: unknown[] }) => source.tables) as Array<{ table: { name: string } } & TableState>;
    for (const name of TABLES) {
      const table = tables.find((entry) => entry.table.name === name)!;
      expect(table.insert_permissions, name).toBeUndefined();
      expect(table.update_permissions, name).toBeUndefined();
      expect(table.delete_permissions, name).toBeUndefined();
      expect(table.select_permissions?.length, name).toBeGreaterThan(0);
    }
  });

  it('the reference holds the state after access groups 0Б (every permission with its predicate)', () => {
    expect(Object.keys(reference).sort()).toEqual(TABLES);
    expect(Object.keys(reference.doweling_orders).sort()).toEqual(['delete', 'insert', 'update']);
    expect(Object.keys(reference.order_doweling_links).sort()).toEqual(['insert', 'update']);
    expect(reference.order_doweling_links.insert!.map((p) => p.role)).toEqual(['erp_admin']);
    for (const permissions of Object.values(reference.doweling_orders)) {
      for (const permission of permissions!) expect(JSON.stringify(permission.permission), permission.role).toContain('user_effective_permissions');
    }
  });

  it('revokes all doweling write permissions in one bulk request; select and other tables stay', async () => {
    const { server, state } = fakeHasura(grantedLive());
    const result = await runScript(server);
    expect(result.code, result.output).toBe(0);
    expect(state.bulkRequests).toBe(1);
    expect(state.tables).toEqual(revokedLive());
    expect(result.output).toContain('doweling_orders/delete: granted (erp_admin, manager, superadmin) -> revoked');
  });

  it('handles metadata of several megabytes (it never passes through an environment variable)', async () => {
    const { server, state } = fakeHasura(grantedLive(), { padding: 3 * 1024 * 1024 });
    const result = await runScript(server);
    expect(result.code, result.output).toBe(0);
    expect(state.bulkRequests).toBe(1);
    // No temp file (metadata may carry connection settings) is left behind.
    expect(readdirSync('/tmp').filter((name) => name.startsWith('doweling-writes-metadata-'))).toEqual([]);
  });

  it('a second run is a no-op; --revert recreates exactly the reference; dry run changes nothing', async () => {
    const again = fakeHasura(revokedLive());
    const againResult = await runScript(again.server);
    expect(againResult.code, againResult.output).toBe(0);
    expect(againResult.output).toContain('Nothing to change.');
    expect(again.state.bulkRequests).toBe(0);
    await stop(again.server);

    const dry = fakeHasura(revokedLive());
    const dryResult = await runScript(dry.server, ['--revert', '--dry-run']);
    expect(dryResult.code, dryResult.output).toBe(0);
    expect(dryResult.output).toContain('Dry run: 15 permission change(s)');
    expect(dry.state.bulkRequests).toBe(0);
    await stop(dry.server);

    const reverted = fakeHasura(revokedLive());
    const revertResult = await runScript(reverted.server, ['--revert']);
    expect(revertResult.code, revertResult.output).toBe(0);
    for (const table of TABLES) {
      for (const [op, permissions] of Object.entries(reference[table])) {
        const live = reverted.state.tables[table][`${op as Op}_permissions`]!;
        const strip = (list: Permission[]) => [...list].sort((a, b) => a.role.localeCompare(b.role)).map(({ role, permission }) => ({ role, permission }));
        expect(strip(live), `${table}/${op}`).toEqual(strip(permissions!));
      }
    }
  });

  it('refuses an unknown live state (another role or another predicate) in both directions', async () => {
    const extra = grantedLive();
    extra.doweling_orders.update_permissions!.push({ role: 'viewer', permission: { columns: '*', filter: {} } });
    for (const args of [[], ['--revert']]) {
      const { server, state } = fakeHasura(extra);
      const result = await runScript(server, args);
      expect(result.code, args.join(' ')).not.toBe(0);
      expect(result.output).toContain('neither the known state nor revoked');
      expect(state.bulkRequests).toBe(0);
      await stop(server);
    }
    const otherFilter = grantedLive();
    otherFilter.order_doweling_links.update_permissions![0].permission = { columns: '*', filter: {} };
    const { server, state } = fakeHasura(otherFilter);
    const result = await runScript(server);
    expect(result.code).not.toBe(0);
    expect(state.bulkRequests).toBe(0);
  });

  it('refuses an unexpected grant of an operation that had none (order_doweling_links delete) in both directions', async () => {
    for (const [initial, args] of [[grantedLive(), []], [revokedLive(), ['--revert']]] as const) {
      const live = JSON.parse(JSON.stringify(initial)) as Live;
      live.order_doweling_links.delete_permissions = [{ role: 'manager', permission: { filter: {} } }];
      const { server, state } = fakeHasura(live);
      const result = await runScript(server, [...args]);
      expect(result.code, args.join(' ')).not.toBe(0);
      expect(result.output).toContain('order_doweling_links/delete: unexpected live permissions (manager)');
      expect(state.bulkRequests).toBe(0);
      await stop(server);
    }
  });

  it('applies nothing when metadata changed after it was read (409)', async () => {
    const live = grantedLive();
    const { server, state } = fakeHasura(live, { bumpAfterExport: true });
    const result = await runScript(server);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('409 conflict');
    expect(state.tables).toEqual(live);
  });

  it('never prints the body of an unexpected Hasura answer, only the status and the machine code', async () => {
    const { server } = fakeHasura(grantedLive(), { failBulk: true });
    const result = await runScript(server);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('HTTP 500 (code: unexpected)');
    expect(result.output).not.toContain('s3cr3t');
    const kept = /kept locally in (\S+)/.exec(result.output)?.[1] ?? '';
    expect(statSync(kept).mode & 0o777).toBe(0o600);
    rmSync(kept);
  });
});

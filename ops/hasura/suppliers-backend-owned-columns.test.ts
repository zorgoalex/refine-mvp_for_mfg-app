import { spawn } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = resolve(process.cwd(), 'ops/hasura/suppliers-backend-owned-columns.sh');
const snapshot = JSON.parse(readFileSync(resolve(process.cwd(), 'ops/hasura/metadata.json'), 'utf8'));

type WritePermission = { role: string; permission: { columns: string[] | '*'; check?: unknown; filter?: unknown; set?: unknown } };
type Kind = 'insert' | 'update';
type Live = Record<Kind, WritePermission[]>;

const snapshotTable = (snapshot.metadata ?? snapshot).sources
  .flatMap((source: { tables: Array<{ table: { name: string; schema?: string } }> }) => source.tables)
  .find((entry: { table: { name: string; schema?: string } }) => entry.table.name === 'suppliers' && (entry.table.schema ?? 'public') === 'public');
const roles: string[] = snapshotTable.insert_permissions.map((p: WritePermission) => p.role).sort();
const wanted = (kind: Kind, role: string): string[] =>
  [...(snapshotTable[`${kind}_permissions`].find((p: WritePermission) => p.role === role).permission.columns as string[])].sort();

// The production state before the release: every role writes all columns.
function allColumnsLive(): Live {
  return {
    insert: roles.map((role) => ({ role, permission: { columns: '*', check: {}, set: { created_by: 'x-hasura-User-Id' } } })),
    update: roles.map((role) => ({ role, permission: { columns: '*', filter: { is_active: { _eq: true } }, check: {}, set: { edited_by: 'x-hasura-User-Id' } } })),
  };
}

// A minimal Hasura metadata API: export_metadata v2 and bulk with resource_version checks.
function fakeHasura(initial: Live, options: { bumpAfterExport?: boolean; failBulk?: boolean } = {}) {
  const state = {
    version: 7,
    suppliers: JSON.parse(JSON.stringify(initial)) as Live,
    other: { role: 'viewer', permission: { columns: '*', check: {} } },
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
            { table: { schema: 'public', name: 'suppliers' }, insert_permissions: state.suppliers.insert, update_permissions: state.suppliers.update },
            { table: { schema: 'public', name: 'other' }, insert_permissions: [state.other] },
          ] }] },
        };
        // Someone edits metadata right after our read.
        if (options.bumpAfterExport) state.version += 1;
        return reply(200, exported);
      }
      if (payload.type === 'bulk') {
        state.bulkRequests += 1;
        if (options.failBulk) return reply(500, { code: 'unexpected', error: 'internal', internal: { url: 'postgres://erp:s3cr3t@db/erp' } });
        if (payload.resource_version !== state.version) return reply(409, { error: 'conflict', code: 'conflict' });
        const next = JSON.parse(JSON.stringify(state.suppliers)) as Live;
        for (const action of payload.args) {
          expect(action.args.table).toEqual({ schema: 'public', name: 'suppliers' });
          const match = /^pg_(drop|create)_(insert|update)_permission$/.exec(action.type);
          if (!match) throw new Error(`unexpected ${action.type}`);
          const list = next[match[2] as Kind];
          if (match[1] === 'drop') list.splice(list.findIndex((entry) => entry.role === action.args.role), 1);
          else list.push({ role: action.args.role, permission: action.args.permission });
        }
        state.suppliers = next;
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

const byRole = (list: WritePermission[]) => Object.fromEntries(list.map((entry) => [entry.role, entry.permission]));

describe('suppliers backend-owned columns script', () => {
  it('replaces «all columns» with the snapshot list in one bulk request, keeping check, filter and set', async () => {
    const { server, state } = fakeHasura(allColumnsLive());
    const result = await runScript(server);
    expect(result.code, result.output).toBe(0);
    expect(state.bulkRequests).toBe(1);
    for (const role of roles) {
      const insert = byRole(state.suppliers.insert)[role];
      const update = byRole(state.suppliers.update)[role];
      expect([...(insert.columns as string[])].sort(), role).toEqual(wanted('insert', role));
      expect([...(update.columns as string[])].sort(), role).toEqual(wanted('update', role));
      expect(insert.columns).not.toContain('ref_key_1c');
      expect(update.columns).not.toContain('ref_key_1c');
      expect(insert.set).toEqual({ created_by: 'x-hasura-User-Id' });
      expect(update.filter).toEqual({ is_active: { _eq: true } });
      expect(update.set).toEqual({ edited_by: 'x-hasura-User-Id' });
    }
    expect(state.other).toEqual({ role: 'viewer', permission: { columns: '*', check: {} } });
  });

  it('refuses a live explicit list with ref_key_1c: only «all columns» may be narrowed, so --revert cannot widen', async () => {
    const live = allColumnsLive();
    for (const kind of ['insert', 'update'] as const) for (const entry of live[kind]) entry.permission.columns = [...wanted(kind, entry.role), 'ref_key_1c'];
    for (const args of [[], ['--revert']]) {
      const { server, state } = fakeHasura(live);
      const result = await runScript(server, args);
      expect(result.code, args.join(' ')).not.toBe(0);
      expect(result.output).toContain("only live: ['ref_key_1c']");
      expect(state.bulkRequests).toBe(0);
      expect(state.suppliers).toEqual(live);
      await stop(server);
    }
  });

  it('never prints the body of an unexpected Hasura answer, only the status and the machine code', async () => {
    const { server, state } = fakeHasura(allColumnsLive(), { failBulk: true });
    const result = await runScript(server);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('HTTP 500 (code: unexpected)');
    expect(result.output).not.toContain('s3cr3t');
    expect(result.output).not.toContain('postgres://');
    expect(state.bulkRequests).toBe(1);
    const kept = /kept locally in (\S+)/.exec(result.output)?.[1] ?? '';
    expect(statSync(kept).mode & 0o777).toBe(0o600);
    expect(readFileSync(kept, 'utf8')).toContain('s3cr3t');
    rmSync(kept);
  });

  it('applies nothing when metadata changed after it was read (409) and fails', async () => {
    const live = allColumnsLive();
    const { server, state } = fakeHasura(live, { bumpAfterExport: true });
    const result = await runScript(server);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('409 conflict');
    expect(state.suppliers).toEqual(live);
  });

  it('refuses unexpected live permissions: another role set or other columns', async () => {
    const extraRole = allColumnsLive();
    extraRole.update.push({ role: 'viewer', permission: { columns: '*', filter: {}, check: {} } });
    const first = fakeHasura(extraRole);
    const firstResult = await runScript(first.server);
    expect(firstResult.code).not.toBe(0);
    expect(firstResult.output).toContain('live roles');
    expect(first.state.bulkRequests).toBe(0);
    await stop(first.server);

    const otherColumns = allColumnsLive();
    otherColumns.insert[0].permission.columns = [...wanted('insert', otherColumns.insert[0].role), 'secret_note'];
    const second = fakeHasura(otherColumns);
    const secondResult = await runScript(second.server);
    expect(secondResult.code).not.toBe(0);
    expect(secondResult.output).toContain("only live: ['secret_note']");
    expect(second.state.bulkRequests).toBe(0);
  });

  it('dry run changes nothing; a second run is a no-op; --revert gives all columns back', async () => {
    const dry = fakeHasura(allColumnsLive());
    const dryResult = await runScript(dry.server, ['--dry-run']);
    expect(dryResult.code, dryResult.output).toBe(0);
    expect(dryResult.output).toContain(`Dry run: ${roles.length * 2} permission(s)`);
    expect(dryResult.output).toContain(`suppliers/${roles[0]}/insert: all columns (*) -> explicit list without ref_key_1c (${wanted('insert', roles[0]).length} columns)`);
    expect(dry.state.bulkRequests).toBe(0);
    await stop(dry.server);

    const applied = fakeHasura(allColumnsLive());
    expect((await runScript(applied.server)).code).toBe(0);
    await stop(applied.server);
    const again = fakeHasura(applied.state.suppliers);
    const againResult = await runScript(again.server);
    expect(againResult.code, againResult.output).toBe(0);
    expect(againResult.output).toContain('Nothing to change.');
    expect(againResult.output).toContain(`suppliers/${roles[0]}/update: explicit list without ref_key_1c (${wanted('update', roles[0]).length} columns): no-change`);
    expect(again.state.bulkRequests).toBe(0);
    await stop(again.server);

    const reverted = fakeHasura(applied.state.suppliers);
    const revertResult = await runScript(reverted.server, ['--revert']);
    expect(revertResult.code, revertResult.output).toBe(0);
    expect(reverted.state.suppliers.insert.every((entry) => entry.permission.columns === '*')).toBe(true);
    expect(reverted.state.suppliers.update.every((entry) => entry.permission.columns === '*')).toBe(true);
    expect(byRole(reverted.state.suppliers.update)[roles[0]].filter).toEqual({ is_active: { _eq: true } });
  });
});

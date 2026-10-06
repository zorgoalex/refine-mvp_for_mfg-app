import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = resolve(process.cwd(), 'ops/hasura/users-no-password-hash.sh');
const snapshot = JSON.parse(readFileSync(resolve(process.cwd(), 'ops/hasura/metadata.json'), 'utf8'));

type Permission = { columns: string[] | '*'; filter?: unknown; check?: unknown; set?: unknown };
type RolePermission = { role: string; permission: Permission };
type Kind = 'select' | 'insert' | 'update';
type UsersPermissions = Record<Kind, RolePermission[]>;

const SENSITIVE = /hash|token|secret|password|api_?key|credential|salt|otp/i;

/** Violations: secret-like columns readable/writable by any role, or a wildcard on users. */
function secretColumnViolations(metadata: any): string[] {
  const root = metadata.metadata ?? metadata;
  const violations: string[] = [];
  for (const source of root.sources) {
    for (const table of source.tables) {
      for (const kind of ['select', 'insert', 'update'] as const) {
        for (const permission of table[`${kind}_permissions`] ?? []) {
          const columns = permission.permission.columns;
          const where = `${table.table.name}/${permission.role}/${kind}`;
          if (!Array.isArray(columns)) {
            // A wildcard on users would silently include password_hash again.
            if (table.table.name === 'users') violations.push(`${where}: columns must be listed explicitly`);
            continue;
          }
          for (const column of columns) if (SENSITIVE.test(column)) violations.push(`${where}: ${column}`);
        }
      }
    }
  }
  return violations;
}

describe('Hasura metadata snapshot', () => {
  it('no role can read or write users.password_hash (or any other secret-like column)', () => {
    expect(secretColumnViolations(snapshot)).toEqual([]);
  });

  it('the guard catches a listed secret column and a wildcard on users', () => {
    const crafted = { sources: [{ tables: [
      { table: { name: 'users' }, select_permissions: [{ role: 'manager', permission: { columns: '*' } }],
        update_permissions: [{ role: 'superadmin', permission: { columns: ['username', 'password_hash'] } }] },
      { table: { name: 'clients' }, select_permissions: [{ role: 'viewer', permission: { columns: '*' } }] },
    ] }] };
    expect(secretColumnViolations(crafted)).toEqual([
      'users/manager/select: columns must be listed explicitly',
      'users/superadmin/update: password_hash',
    ]);
  });
});

function fakeHasura(initial: UsersPermissions, options: { bumpAfterExport?: boolean } = {}) {
  const state = {
    version: 11,
    users: JSON.parse(JSON.stringify(initial)) as UsersPermissions,
    other: { role: 'manager', permission: { columns: ['id', 'secret_note_ok'], filter: { id: { _eq: 1 } } } },
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
            { table: { schema: 'public', name: 'users' }, select_permissions: state.users.select,
              insert_permissions: state.users.insert, update_permissions: state.users.update },
            { table: { schema: 'public', name: 'other' }, select_permissions: [state.other] },
          ] }] },
        };
        if (options.bumpAfterExport) state.version += 1;
        return reply(200, exported);
      }
      if (payload.type === 'bulk') {
        state.bulkRequests += 1;
        if (payload.resource_version !== state.version) return reply(409, { error: 'conflict', code: 'conflict' });
        const next = JSON.parse(JSON.stringify(state.users)) as UsersPermissions;
        for (const action of payload.args) {
          expect(action.args.table).toEqual({ schema: 'public', name: 'users' });
          const match = /^pg_(drop|create)_(select|insert|update)_permission$/.exec(action.type);
          if (!match) throw new Error(`unexpected ${action.type}`);
          const list = next[match[2] as Kind];
          const index = list.findIndex((entry) => entry.role === action.args.role);
          if (match[1] === 'drop') list.splice(index, 1);
          else list.push({ role: action.args.role, permission: action.args.permission });
        }
        state.users = next;
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

const leaking: UsersPermissions = {
  select: [
    { role: 'manager', permission: { columns: ['user_id', 'username', 'password_hash'], filter: {} } },
    { role: 'viewer', permission: { columns: ['user_id', 'password_hash'], filter: { is_active: { _eq: true } } } },
  ],
  insert: [{ role: 'superadmin', permission: { columns: ['username', 'password_hash'], check: {}, set: { created_by: 'x-hasura-User-Id' } } }],
  update: [{ role: 'superadmin', permission: { columns: ['username', 'password_hash'], filter: {}, check: {}, set: { edited_by: 'x-hasura-User-Id' } } }],
};

describe('users-no-password-hash.sh', () => {
  it('removes the column from select, insert and update of every role, keeping everything else, in one bulk', async () => {
    const { server, state } = fakeHasura(leaking);
    const result = await runScript(server);
    expect(result.code, result.output).toBe(0);
    expect(state.bulkRequests).toBe(1);
    const by = (kind: Kind) => Object.fromEntries(state.users[kind].map((entry) => [entry.role, entry.permission]));
    expect(by('select').manager).toEqual({ columns: ['user_id', 'username'], filter: {} });
    expect(by('select').viewer).toEqual({ columns: ['user_id'], filter: { is_active: { _eq: true } } });
    expect(by('insert').superadmin).toEqual({ columns: ['username'], check: {}, set: { created_by: 'x-hasura-User-Id' } });
    expect(by('update').superadmin).toEqual({ columns: ['username'], filter: {}, check: {}, set: { edited_by: 'x-hasura-User-Id' } });
    expect(state.other.permission.columns).toEqual(['id', 'secret_note_ok']);
  });

  it('applies nothing and fails when metadata changed after it was read (409)', async () => {
    const { server, state } = fakeHasura(leaking, { bumpAfterExport: true });
    const result = await runScript(server);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('409 conflict');
    expect(state.users).toEqual(leaking);
  });

  it('refuses a columns="*" permission instead of guessing', async () => {
    const { server, state } = fakeHasura({ ...leaking, select: [{ role: 'manager', permission: { columns: '*', filter: {} } }] });
    const result = await runScript(server);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("uses columns='*'");
    expect(state.bulkRequests).toBe(0);
  });

  it('has no revert mode (re-adding the column could widen permissions that never had it)', async () => {
    const { server, state } = fakeHasura(leaking);
    const result = await runScript(server, ['--revert']);
    expect(result.code).toBe(2);
    expect(result.output).toContain('unknown argument: --revert');
    expect(state.bulkRequests).toBe(0);
  });

  it('leaves permissions that never had the column untouched', async () => {
    const safe: UsersPermissions = { ...leaking, select: [...leaking.select, { role: 'worker', permission: { columns: ['user_id'], filter: {} } }] };
    const { server, state } = fakeHasura(safe);
    const result = await runScript(server);
    expect(result.code, result.output).toBe(0);
    expect(state.users.select.find((entry) => entry.role === 'worker')?.permission).toEqual({ columns: ['user_id'], filter: {} });
    expect(result.output).toContain('users/worker/select: no-change');
  });

  it('dry run changes nothing; a second run is a no-op', async () => {
    const dry = fakeHasura(leaking);
    const dryResult = await runScript(dry.server, ['--dry-run']);
    expect(dryResult.code, dryResult.output).toBe(0);
    expect(dryResult.output).toContain('Dry run: 4 permission(s)');
    expect(dry.state.bulkRequests).toBe(0);
    await stop(dry.server);

    const applied = fakeHasura(leaking);
    await runScript(applied.server);
    const fixed = applied.state.users;
    await stop(applied.server);

    const again = fakeHasura(fixed);
    const againResult = await runScript(again.server);
    expect(againResult.output).toContain('Nothing to change.');
    expect(again.state.bulkRequests).toBe(0);
  });
});

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { HASURA_WRITE_PERMISSIONS } from '../../src/utils/resourcePermissions';

const root = process.cwd();
const scriptPath = resolve(root, 'ops/hasura/access-predicates.sh');
const modulePath = resolve(root, 'ops/hasura/access_predicates.py');
const rulesPath = resolve(root, 'ops/hasura/access-predicates.json');
const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
const snapshotText = readFileSync(resolve(root, 'ops/hasura/metadata.json'), 'utf8');
const snapshot = JSON.parse(snapshotText);
const OPS = ['select', 'insert', 'update', 'delete'] as const;

type Permission = { role: string; permission: Record<string, unknown> };
type Table = { table: { name: string }; object_relationships?: Array<{ name: string }>; array_relationships?: Array<{ name: string }> } &
  Partial<Record<`${(typeof OPS)[number]}_permissions`, Permission[]>>;
const tables: Table[] = snapshot.sources[0].tables;

function python(args: string[], input: string) {
  return spawnSync('python3', [modulePath, ...args, '--rules', rulesPath], { input, encoding: 'utf8' });
}

describe('access groups 0Б: Hasura permissions follow effective permissions (metadata snapshot)', () => {
  it('has both steps applied in the snapshot (a rebuild changes nothing)', () => {
    const result = python(['status'], snapshotText);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('A=applied B=applied');
  });

  it('gives every permission of every role an effective-permission predicate, except the listed exceptions', () => {
    const missing: string[] = [];
    for (const table of tables) {
      for (const op of OPS) {
        for (const { role, permission } of table[`${op}_permissions`] ?? []) {
          const exception = `${table.table.name}.${op}` in rules.exceptions;
          const keys = op === 'insert' ? ['check'] : op === 'update' ? ['filter', 'check'] : ['filter'];
          for (const key of keys) {
            if (!exception && !JSON.stringify(permission[key] ?? {}).includes('"user_effective_permissions"')) {
              missing.push(`${table.table.name}.${op}.${key}/${role}`);
            }
          }
        }
      }
    }
    expect(missing).toEqual([]);
    expect(Object.keys(rules.exceptions)).toEqual(['app_settings.select']);
  });

  it('never lets a role read secrets or session tokens', () => {
    const users = tables.find((table) => table.table.name === 'users');
    for (const { permission } of users?.select_permissions ?? []) expect(permission.columns).not.toContain('password_hash');
    const refreshTokens = tables.find((table) => table.table.name === 'refresh_tokens');
    for (const op of OPS) expect(refreshTokens?.[`${op}_permissions`] ?? []).toEqual([]);
  });

  it('removes every revoked permission and gives the Hasura superuser role admin nothing to rely on', () => {
    for (const [name, ops] of Object.entries(rules.revoke as Record<string, string[]>)) {
      const table = tables.find((entry) => entry.table.name === name);
      for (const op of ops) {
        const left = (table?.[`${op as (typeof OPS)[number]}_permissions`] ?? []).map((permission) => permission.role);
        expect(left.filter((role) => role !== rules.adminRole), `${name}.${op}`).toEqual([]);
      }
    }
    expect(snapshotText.includes('"role": "admin"')).toBe(false);
  });

  it('has every relationship that the predicates traverse', () => {
    for (const relationship of rules.relationships) {
      const table = tables.find((entry) => entry.table.name === relationship.table);
      const list = relationship.type === 'object' ? table?.object_relationships : table?.array_relationships;
      expect(list?.some((entry) => entry.name === relationship.name), `${relationship.table}.${relationship.name}`).toBe(true);
    }
    for (const view of rules.trackTables) expect(tables.some((entry) => entry.table.name === view), view).toBe(true);
  });

  it('keeps the frontend write map equal to the Hasura write rules', () => {
    const fromRules: Record<string, Record<string, string[]>> = {};
    for (const [name, byOp] of Object.entries(rules.tables as Record<string, Record<string, { any?: string[]; all?: string[] }>>)) {
      for (const op of ['insert', 'update', 'delete']) {
        const rule = byOp[op];
        if (!rule) continue;
        fromRules[name] ??= {};
        fromRules[name][op] = [...(rule.any ?? []), ...(rule.all ?? [])];
      }
    }
    const fromFrontend = Object.fromEntries(
      Object.entries(HASURA_WRITE_PERMISSIONS).map(([name, byOp]) => [name, Object.fromEntries(Object.entries(byOp).map(([op, list]) => [op, [...(list ?? [])]]))]),
    );
    expect(fromFrontend).toEqual(fromRules);
  });
});

// ------------------------------------------------------------------ the apply/revert script against a fake Hasura

const base = {
  version: 3,
  sources: [{
    name: 'default', kind: 'postgres', configuration: {},
    tables: [
      { table: { schema: 'public', name: 'edge_types' },
        select_permissions: [{ role: 'manager', permission: { columns: ['edge_type_id'], filter: {} } }],
        update_permissions: [{ role: 'manager', permission: { columns: ['edge_type_name'], filter: {}, check: {} } }] },
      { table: { schema: 'public', name: 'vehicles' }, select_permissions: [{ role: 'manager', permission: { columns: ['vehicle_id'], filter: {} } }] },
    ],
  }],
};
const miniRules = {
  adminRole: 'erp_admin', adminTemplateRole: 'superadmin', trackTables: ['user_effective_permissions', 'user_effective_scopes'],
  relationships: [], exceptions: {}, revoke: { vehicles: ['select'] },
  tables: { edge_types: { select: { any: ['references.view'] }, update: { any: ['references.manage'] } } },
};
const MATRIX = ['p|manager|references.manage', 'p|manager|references.view', 's|manager|orders.view=own'];

// A minimal Hasura: export_metadata v2, replace_metadata with resource_version, run_sql for the role matrix and the
// permissions_state flag (a write sets it; the matrix is answered from `state.matrix`).
function fakeHasura(options: { bumpAfterExport?: boolean; loseReplaceAnswer?: number; failFlagWrite?: number; failExportAfterLoss?: number; failAudit?: number } = {}) {
  const state = {
    version: 3, metadata: JSON.parse(JSON.stringify(base)), matrix: [...MATRIX], flag: false, replaces: 0,
    flagWrites: [] as boolean[], audits: [] as string[],
    loseReplaceAnswer: options.loseReplaceAnswer ?? 0, failFlagWrite: options.failFlagWrite ?? 0,
    failExportAfterLoss: options.failExportAfterLoss ?? 0, failAudit: options.failAudit ?? 0, lostAnswer: false,
  };
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      const reply = (code: number, value: unknown) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (request.headers['x-hasura-admin-secret'] !== 'test-secret') return reply(401, { error: 'no secret' });
      if (payload.type === 'export_metadata') {
        if (state.lostAnswer && state.failExportAfterLoss > 0) { state.failExportAfterLoss -= 1; return reply(503, { error: 'unavailable' }); }
        const exported = { resource_version: state.version, metadata: state.metadata };
        if (options.bumpAfterExport) state.version += 1;
        return reply(200, exported);
      }
      if (payload.type === 'replace_metadata') {
        if (payload.resource_version !== state.version) return reply(409, { error: 'conflict', code: 'conflict' });
        state.metadata = payload.args.metadata;
        state.version += 1;
        state.replaces += 1;
        // The change is applied but a proxy loses the answer.
        if (state.loseReplaceAnswer > 0) { state.loseReplaceAnswer -= 1; state.lostAnswer = true; return reply(502, { error: 'bad gateway' }); }
        state.lostAnswer = false;
        return reply(200, { is_consistent: true, inconsistent_objects: [] });
      }
      if (payload.type === 'run_sql') {
        const sql: string = payload.args.sql;
        if (!payload.args.read_only && sql.includes('SET hasura_access_predicates')) {
          expect(sql.indexOf('FOR UPDATE')).toBeLessThan(sql.indexOf('UPDATE public.permissions_state SET hasura_access_predicates'));
          expect(sql).toContain('INSERT INTO public.audit_log');
          if (state.failFlagWrite > 0) { state.failFlagWrite -= 1; return reply(500, { error: 'database unavailable' }); }
          state.flag = sql.includes('SET hasura_access_predicates = true');
          state.flagWrites.push(state.flag);
          state.audits.push(sql);
        } else if (!payload.args.read_only) {
          expect(sql).toContain('INSERT INTO public.audit_log');
          if (state.failAudit > 0) { state.failAudit -= 1; return reply(500, { error: 'audit insert failed' }); }
          state.audits.push(sql);
          return reply(200, { result: [['ok'], ['ok']] });
        }
        if (sql.startsWith('SELECT hasura_access_predicates')) return reply(200, { result: [['v'], [String(state.flag)]] });
        return reply(200, { result_type: 'TuplesOk', result: [['grant'], ...state.matrix.map((row) => [row])] });
      }
      return reply(400, { error: `unexpected ${payload.type}` });
    });
  });
  return { server, state };
}

let running: Server | undefined;
let stateDir: string | undefined;
afterEach(async () => {
  await new Promise<void>((done) => (running ? running.close(() => done()) : done()));
  running = undefined;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = undefined;
});

async function listen(server: Server) {
  running = server;
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  return (server.address() as AddressInfo).port;
}

function runScript(port: number, args: string[], rulesFile: string) {
  return new Promise<{ code: number | null; output: string }>((done) => {
    const child = spawn('python3', [modulePath, args[0], '--rules', rulesFile, ...args.slice(1)], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HASURA_BASE_URL: `http://127.0.0.1:${port}`, HASURA_ADMIN_SECRET: 'test-secret' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => done({ code, output }));
  });
}

describe('access-predicates apply / revert', () => {
  // Rules, the approved snapshot after B (built from the base) and the state directory, in one temp directory.
  const prepare = (metadataForExpect: unknown = base) => {
    stateDir = mkdtempSync(join(tmpdir(), 'ag0b-'));
    const rulesFile = join(stateDir, 'rules.json');
    writeFileSync(rulesFile, JSON.stringify(miniRules));
    const afterA = spawnSync('python3', [modulePath, 'build', '--step', 'A', '--rules', rulesFile], { input: JSON.stringify(metadataForExpect), encoding: 'utf8' });
    const afterB = spawnSync('python3', [modulePath, 'build', '--step', 'B', '--rules', rulesFile], { input: afterA.stdout, encoding: 'utf8' });
    const expectFile = join(stateDir, 'expect.json');
    writeFileSync(expectFile, afterB.stdout);
    return { rulesFile, expectFile, dir: join(stateDir, 'state') };
  };
  const apply = (port: number, step: string, files: ReturnType<typeof prepare>, extra: string[] = []) =>
    runScript(port, ['apply', '--step', step, '--state-dir', files.dir, '--expect', files.expectFile, ...extra], files.rulesFile);
  const revert = (port: number, files: ReturnType<typeof prepare>, extra: string[] = []) =>
    runScript(port, ['revert', '--step', 'B', '--state-dir', files.dir, ...extra], files.rulesFile);

  it('refuses B before A, applies A then B in one replace each, sets the flag with B, and a second run changes nothing', async () => {
    const files = prepare();
    const { server, state } = fakeHasura();
    const port = await listen(server);
    expect((await apply(port, 'B', files)).output).toContain('step A is not applied');
    expect((await apply(port, 'A', files)).code).toBe(0);
    expect(state.flag).toBe(false);
    const b = await apply(port, 'B', files);
    expect(b.code, b.output).toBe(0);
    expect(state.replaces).toBe(2);
    expect(state.flag).toBe(true);
    const tablesAfter = state.metadata.sources[0].tables;
    expect(tablesAfter.find((t: Table) => t.table.name === 'vehicles').select_permissions).toBeUndefined();
    expect(JSON.stringify(tablesAfter.find((t: Table) => t.table.name === 'edge_types').update_permissions[0].permission.filter))
      .toContain('"references.manage"');
    expect(JSON.parse(readFileSync(join(files.dir, 'B-current', 'matrix-at-B.json'), 'utf8'))).toEqual([...MATRIX].sort());
    expect((await apply(port, 'B', files)).output).toContain('already applied');
    expect(state.replaces).toBe(2);
  });

  it('ignores what is not semantic: column order and an empty comment of a recreated permission', async () => {
    const recreated = JSON.parse(JSON.stringify(base));
    recreated.sources[0].tables[0].select_permissions[0] = { role: 'manager', comment: '', permission: { filter: {}, columns: ['edge_type_id'] } };
    recreated.sources[0].tables[0].update_permissions[0].permission.columns = ['edge_type_name'];
    const files = prepare();
    const { server, state } = fakeHasura();
    state.metadata = recreated;
    const port = await listen(server);
    expect((await apply(port, 'A', files)).code).toBe(0);
  });

  it('refuses live metadata that does not lead to the approved snapshot (unknown drift), changing nothing', async () => {
    const drifted = JSON.parse(JSON.stringify(base));
    drifted.sources[0].tables[0].select_permissions[0].permission.columns = ['edge_type_id', 'secret_column'];
    const files = prepare();
    const { server, state } = fakeHasura();
    state.metadata = drifted;
    const port = await listen(server);
    const result = await apply(port, 'A', files);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('unknown drift');
    expect(state.replaces).toBe(0);
  });

  it('applies nothing on 409 and keeps no pending generation', async () => {
    const files = prepare();
    const { server, state } = fakeHasura({ bumpAfterExport: true });
    const port = await listen(server);
    const result = await apply(port, 'A', files);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('409 conflict');
    expect(state.replaces).toBe(0);
    expect(readdirSync(files.dir).filter((name) => !name.startsWith('.'))).toEqual([]);
  });

  it('refuses a second command while the state directory is locked', async () => {
    const files = prepare();
    const { server } = fakeHasura();
    const port = await listen(server);
    await apply(port, 'A', files);
    const locker = spawn('python3', ['-c', `import fcntl,time; f=open(${JSON.stringify(join(files.dir, '.lock'))},'w'); fcntl.flock(f, fcntl.LOCK_EX); print('locked', flush=True); time.sleep(5)`]);
    await new Promise<void>((done) => locker.stdout.once('data', () => done()));
    const result = await apply(port, 'B', files);
    locker.kill();
    expect(result.output).toContain('another access-predicates command holds');
  });

  it('revert clears the flag first, refuses when a role grant was narrowed after B (flag restored), reverts once restored', async () => {
    const files = prepare();
    const { server, state } = fakeHasura();
    const port = await listen(server);
    await apply(port, 'A', files);
    const afterA = JSON.stringify(state.metadata);
    await apply(port, 'B', files);

    state.matrix = ['p|manager|references.view', 's|manager|orders.view=own'];
    const refused = await revert(port, files);
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain('p|manager|references.manage');
    expect(state.flagWrites.slice(-2)).toEqual([false, true]);
    expect(state.flag).toBe(true);
    expect(state.replaces).toBe(2);

    // Widening own → all is not a loss.
    state.matrix = ['p|manager|references.manage', 'p|manager|references.view', 's|manager|orders.view=all'];
    const reverted = await revert(port, files);
    expect(reverted.code, reverted.output).toBe(0);
    expect(JSON.stringify(state.metadata)).toBe(afterA);
    expect(state.flag).toBe(false);
    expect(readdirSync(files.dir).some((name) => name.endsWith('.reverted'))).toBe(true);
    expect(readdirSync(files.dir)).not.toContain('B-current');
  });

  it('refuses to revert over metadata changed after B', async () => {
    const files = prepare();
    const { server, state } = fakeHasura();
    const port = await listen(server);
    await apply(port, 'A', files);
    await apply(port, 'B', files);
    state.metadata.sources[0].tables.push({ table: { schema: 'public', name: 'someone_else' } });
    const result = await revert(port, files);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('metadata changed after step B');
    expect(state.flag).toBe(true);
  });

  it('a dry run changes nothing, not even the flag of an applied step B', async () => {
    const files = prepare();
    const { server, state } = fakeHasura();
    const port = await listen(server);
    await apply(port, 'A', files);
    await apply(port, 'B', files);
    state.flag = false;
    const writes = state.flagWrites.length;
    const dry = await apply(port, 'B', files, ['--dry-run']);
    expect(dry.output).toContain('already applied; flag=false. Nothing changed.');
    expect(state.flagWrites.length).toBe(writes);
    expect(state.flag).toBe(false);
  });

  it('resumes an interrupted step B: the matrix snapshot is written before the flag, a re-run sets the flag and confirms', async () => {
    const files = prepare();
    const { server, state } = fakeHasura({ failFlagWrite: 1 });
    const port = await listen(server);
    await apply(port, 'A', files);
    const failed = await apply(port, 'B', files);
    expect(failed.code).not.toBe(0);
    expect(state.flag).toBe(false);
    const pending = readdirSync(files.dir).filter((name) => name.startsWith('B-') && name.endsWith('.pending'));
    expect(pending).toHaveLength(1);
    expect(readdirSync(join(files.dir, pending[0]))).toContain('matrix-at-B.json');

    const resumed = await apply(port, 'B', files);
    expect(resumed.code, resumed.output).toBe(0);
    expect(state.flag).toBe(true);
    expect(readdirSync(files.dir)).toContain('B-current');
    expect(readdirSync(files.dir).filter((name) => name.endsWith('.pending'))).toEqual([]);
    expect((await revert(port, files)).code).toBe(0);
  });

  it('treats a lost answer of the revert replace as done (re-read), keeps the flag false and audits the run', async () => {
    const files = prepare();
    const { server, state } = fakeHasura();
    const port = await listen(server);
    await apply(port, 'A', files);
    const afterA = JSON.stringify(state.metadata);
    await apply(port, 'B', files);
    state.loseReplaceAnswer = 1;
    const result = await revert(port, files, ['--operator', 'tester']);
    expect(result.code, result.output).toBe(0);
    expect(JSON.stringify(state.metadata)).toBe(afterA);
    expect(state.flag).toBe(false);
    const last = state.audits[state.audits.length - 1];
    expect(last).toContain('"result": "reverted"');
    expect(last).toContain('"operator": "tester"');
    expect(last).toMatch(/ops-access-predicates-[0-9a-f-]{36}/);
  });

  it('a lost answer of the apply replace is confirmed by re-reading, not reported as a failure', async () => {
    const files = prepare();
    const { server, state } = fakeHasura({ loseReplaceAnswer: 1 });
    const port = await listen(server);
    const result = await apply(port, 'A', files);
    expect(result.code, result.output).toBe(0);
    expect(readdirSync(files.dir)).toContain('A-current');
    expect(state.replaces).toBe(1);
  });

  it('keeps the pending generation when the outcome is unknown (answer lost, re-read failed) and resumes it later', async () => {
    const files = prepare();
    const { server, state } = fakeHasura();
    const port = await listen(server);
    expect((await apply(port, 'A', files)).code).toBe(0);
    // B is applied by Hasura, its answer is lost and the re-read fails too.
    state.loseReplaceAnswer = 1;
    state.failExportAfterLoss = 1;
    const unknown = await apply(port, 'B', files);
    expect(unknown.code).not.toBe(0);
    expect(unknown.output).toContain('state unknown');
    expect(readdirSync(files.dir).filter((name) => name.startsWith('B-') && name.endsWith('.pending'))).toHaveLength(1);
    expect(state.flag).toBe(false);

    const resumed = await apply(port, 'B', files);
    expect(resumed.code, resumed.output).toBe(0);
    expect(readdirSync(files.dir)).toContain('B-current');
    expect(state.flag).toBe(true);
    expect((await revert(port, files)).code).toBe(0);
  });

  it('a stale pending generation never replaces the confirmed one: failed-before-apply → retry → narrowing → re-apply → revert refuses', async () => {
    const files = prepare();
    const { server, state } = fakeHasura();
    const port = await listen(server);
    expect((await apply(port, 'A', files)).code).toBe(0);
    // First B: Hasura rejects (502) WITHOUT applying, and the re-read fails too → unknown outcome, pending kept.
    const original = state.metadata;
    state.loseReplaceAnswer = 1;
    state.failExportAfterLoss = 1;
    const replaceBefore = state.replaces;
    const realMetadata = JSON.stringify(original);
    const first = await apply(port, 'B', files);
    // Simulate «not applied»: restore the metadata the fake had applied.
    state.metadata = JSON.parse(realMetadata);
    state.replaces = replaceBefore;
    expect(first.output).toContain('state unknown');
    expect(readdirSync(files.dir).filter((name) => name.endsWith('.pending'))).toHaveLength(1);

    expect((await apply(port, 'B', files)).code).toBe(0);
    expect(readdirSync(files.dir).filter((name) => name.endsWith('.pending'))).toEqual([]);
    state.matrix = ['p|manager|references.view', 's|manager|orders.view=own'];
    expect((await apply(port, 'B', files)).code).toBe(0);
    const refused = await revert(port, files);
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain('p|manager|references.manage');
  });

  it('refuses to rebuild a missing matrix snapshot while the flag is already true', async () => {
    const files = prepare();
    const { server, state } = fakeHasura();
    const port = await listen(server);
    await apply(port, 'A', files);
    await apply(port, 'B', files);
    rmSync(join(files.dir, 'B-current', 'matrix-at-B.json'));
    // Make B-current look unconfirmed for its metadata: a pending copy without the snapshot.
    const result = await apply(port, 'B', files);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('rollback baseline cannot be reconstructed');
    expect(state.flag).toBe(true);
  });

  it('a revert whose completion audit failed is completed by the retry with the original run, override and grants', async () => {
    const files = prepare();
    const { server, state } = fakeHasura();
    const port = await listen(server);
    await apply(port, 'A', files);
    const afterA = JSON.stringify(state.metadata);
    await apply(port, 'B', files);
    state.matrix = ['p|manager|references.view', 's|manager|orders.view=own'];
    state.failAudit = 1;
    const failed = await revert(port, files, ['--allow-reopen', '--operator', 'first']);
    expect(failed.code).not.toBe(0);
    expect(JSON.stringify(state.metadata)).toBe(afterA);
    expect(state.flag).toBe(false);

    const retried = await revert(port, files, ['--operator', 'second']);
    expect(retried.code, retried.output).toBe(0);
    const completion = state.audits.filter((sql) => sql.includes('"result": "reverted"'));
    expect(completion).toHaveLength(1);
    expect(completion[0]).toContain('"allowReopen": true');
    expect(completion[0]).toContain('p|manager|references.manage');
    expect(completion[0]).toContain('"operator": "first"');
    expect(readdirSync(files.dir)).not.toContain('B-current');
  });

  it('records --allow-reopen with the reopened grants in the audit', async () => {
    const files = prepare();
    const { server, state } = fakeHasura();
    const port = await listen(server);
    await apply(port, 'A', files);
    await apply(port, 'B', files);
    state.matrix = ['p|manager|references.view', 's|manager|orders.view=own'];
    const result = await revert(port, files, ['--allow-reopen']);
    expect(result.code, result.output).toBe(0);
    const last = state.audits[state.audits.length - 1];
    expect(last).toContain('"allowReopen": true');
    expect(last).toContain('p|manager|references.manage');
  });

  it('the shell wrapper never prints the admin secret', async () => {
    const { server } = fakeHasura();
    const port = await listen(server);
    const result = await new Promise<{ output: string }>((done) => {
      const child = spawn('bash', [scriptPath, 'status'], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HASURA_GRAPHQL_ENDPOINT: `http://127.0.0.1:${port}/v1/graphql`, HASURA_ADMIN_SECRET: 'test-secret' },
      });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.on('close', () => done({ output }));
    });
    // The real rules need tables the fake metadata lacks: status reports the error — without the secret.
    expect(result.output).toContain('relationship on untracked table');
    expect(result.output).not.toContain('test-secret');
  });
});

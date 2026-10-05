import { randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Explicit opt-in. Works only in randomly named disposable databases created from the SCHEMA of the test database
// (no business data is copied or touched). Requires CREATEDB rights on the test PostgreSQL container.
const enabled = process.env.ERP_MIGRATION_PROBE_INTEGRATION === 'true';
const container = process.env.PG_CONTAINER || 'erp_test-postgresdb-1';
const suffix = randomBytes(8).toString('hex');
const baseDb = `e2e_onec_role_base_${suffix}`;
const migration = readFileSync(resolve(__dirname, '245_onec_operator_role.sql'), 'utf8');
const rollbackPath = resolve(__dirname, '245_onec_operator_role_rollback.sql');
const PSQL = 'exec psql -U "$POSTGRES_USER" -d "$1" -X -qAt -v ON_ERROR_STOP=1';

function psql(db: string, input: string, extraArgs = '') {
  return spawnSync('docker', ['exec', '-i', container, 'sh', '-lc', `${PSQL} ${extraArgs}`, 'onec-role-test', db],
    { input, encoding: 'utf8', timeout: 60000 });
}
function sql(db: string, input: string): string {
  const result = psql(db, input);
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout.trim();
}
function shell(script: string, timeout = 120000): string {
  return execFileSync('docker', ['exec', '-i', container, 'sh', '-lc', script], { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] });
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const databases: string[] = [];

/** A fresh copy of the migrated-or-not base database for one scenario. */
function scenarioDb(name: string, template = baseDb): string {
  const db = `e2e_onec_role_${name}_${suffix}`;
  sql('postgres', `CREATE DATABASE ${db} TEMPLATE ${template};`);
  databases.push(db);
  return db;
}
function user(db: string, username: string, roleId: number, active = true): string {
  return sql(db, `INSERT INTO users (username, email, password_hash, role_id, is_active)
    VALUES ('E2E-Тест-${username}', 'e2e-${username}-${suffix}@example.invalid', 'x', ${roleId}, ${active}) RETURNING user_id;`);
}
function rollback(db: string, actorId: string) {
  return spawnSync('docker', ['exec', '-i', container, 'sh', '-lc', `${PSQL} -v actor_id="$2"`, 'onec-role-test', db, actorId],
    { input: readFileSync(rollbackPath, 'utf8'), encoding: 'utf8', timeout: 60000 });
}

describe.skipIf(!enabled)('245 onec_operator role: migration, role guard trigger and manual rollback on PostgreSQL', () => {
  let migratedDb = '';

  beforeAll(() => {
    sql('postgres', `CREATE DATABASE ${baseDb} TEMPLATE template0;`);
    databases.push(baseDb);
    // Real schema of the test database + the rows of the permission tables only.
    shell(`pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -s --no-owner | psql -q -X -U "$POSTGRES_USER" -d ${baseDb} >/dev/null 2>&1;
      pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -a --no-owner -t roles -t permissions_catalog -t role_permissions -t role_policy_scopes -t permissions_state \
        | psql -q -X -U "$POSTGRES_USER" -d ${baseDb} >/dev/null 2>&1`);
    // The test database may already have the role (stage after the release): start every scenario without it.
    sql(baseDb, `DROP TRIGGER IF EXISTS trg_users_onec_operator_role_guard ON users;
      DELETE FROM role_policy_scopes WHERE role_id = 32; DELETE FROM role_permissions WHERE role_id = 32; DELETE FROM roles WHERE role_id = 32;`);
    migratedDb = `e2e_onec_role_migrated_${suffix}`;
    sql('postgres', `CREATE DATABASE ${migratedDb} TEMPLATE ${baseDb};`);
    databases.push(migratedDb);
    sql(migratedDb, migration);
  }, 180000);

  afterAll(() => {
    for (const db of databases.reverse()) {
      try { sql('postgres', `DROP DATABASE IF EXISTS ${db} WITH (FORCE);`); } catch { /* reported by the leftover check below */ }
    }
    const left = sql('postgres', `SELECT count(*) FROM pg_database WHERE datname LIKE 'e2e_onec_role_%_${suffix}';`);
    expect(left).toBe('0');
  }, 120000);

  it('creates the role with exactly six enabled permissions and all scopes none; replay changes nothing', () => {
    const snapshot = () => sql(migratedDb, `
      SELECT role_code || '|' || role_name || '|' || is_active FROM roles WHERE role_id = 32;
      SELECT string_agg(permission_name, ',' ORDER BY permission_name) FROM role_permissions WHERE role_id = 32 AND is_enabled;
      SELECT count(*) || '/' || count(*) FILTER (WHERE scope_value = 'none') FROM role_policy_scopes WHERE role_id = 32;
      SELECT last_value FROM roles_role_id_seq;
      SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_users_onec_operator_role_guard' AND NOT tgisinternal;`);
    const first = snapshot();
    expect(first.split('\n')).toEqual([
      'onec_operator|Оператор интеграции 1С|true',
      'onec.commands.send,onec.manage,onec.view,profile.update_own,profile.view,sessions.logout_own',
      '10/10',
      sql(baseDb, 'SELECT last_value FROM roles_role_id_seq;'),
      '1',
    ]);
    sql(migratedDb, migration);
    expect(snapshot()).toBe(first);
  }, 60000);

  it('never moves the role sequence backwards and refuses a taken id or code without partial changes', () => {
    const seq = scenarioDb('seq');
    sql(seq, "SELECT setval('roles_role_id_seq', 500);");
    sql(seq, migration);
    expect(sql(seq, 'SELECT last_value FROM roles_role_id_seq;')).toBe('500');

    for (const [name, conflict] of [
      ['takenid', "INSERT INTO roles (role_id, role_code, role_name, role_description) VALUES (32, 'e2e_other', 'x', 'x');"],
      ['takencode', "INSERT INTO roles (role_id, role_code, role_name, role_description) VALUES (77, 'onec_operator', 'x', 'x');"],
    ] as const) {
      const db = scenarioDb(name);
      sql(db, conflict);
      const result = psql(db, migration);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/migration 245: role/);
      expect(sql(db, "SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_users_onec_operator_role_guard';")).toBe('0');
      expect(sql(db, 'SELECT count(*) FROM role_permissions WHERE role_id = 32;')).toBe('0');
    }
  }, 60000);

  it('rejects every role change to or from the operator role, on any write path; other changes and creation pass', () => {
    const db = scenarioDb('guard', migratedDb);
    const viewer = user(db, 'viewer', 100);
    const operator = user(db, 'operator', 32);

    const promote = psql(db, `UPDATE users SET role_id = 32 WHERE user_id = ${viewer};`);
    expect(promote.status).not.toBe(0);
    expect(promote.stderr).toContain('ONEC_OPERATOR_ROLE_TRANSITION');
    const demote = psql(db, `UPDATE users SET role_id = 1 WHERE user_id = ${operator};`);
    expect(demote.status).not.toBe(0);
    expect(demote.stderr).toContain('ONEC_OPERATOR_ROLE_TRANSITION');
    expect(sql(db, `SELECT string_agg(role_id::text, ',' ORDER BY user_id) FROM users WHERE user_id IN (${viewer}, ${operator});`)).toBe('100,32');

    // Unrelated role changes and updates that keep the role are untouched.
    sql(db, `UPDATE users SET role_id = 10 WHERE user_id = ${viewer}; UPDATE users SET role_id = 32, full_name = 'E2E' WHERE user_id = ${operator};`);
    expect(sql(db, `SELECT role_id FROM users WHERE user_id = ${viewer};`)).toBe('10');

    // The maintenance switch is transaction-local.
    sql(db, `BEGIN; SET LOCAL app.onec_operator_role_maintenance = 'on'; UPDATE users SET role_id = 100 WHERE user_id = ${operator}; COMMIT;`);
    expect(sql(db, `SELECT role_id FROM users WHERE user_id = ${operator};`)).toBe('100');
    expect(psql(db, `UPDATE users SET role_id = 32 WHERE user_id = ${operator};`).stderr).toContain('ONEC_OPERATOR_ROLE_TRANSITION');

    // Role switched off: no new operators, even with the maintenance switch.
    sql(db, 'UPDATE roles SET is_active = false WHERE role_id = 32;');
    const disabled = psql(db, "INSERT INTO users (username, email, password_hash, role_id) VALUES ('E2E-Тест-late', 'e2e-late@example.invalid', 'x', 32);");
    expect(disabled.status).not.toBe(0);
    expect(disabled.stderr).toContain('ONEC_OPERATOR_ROLE_DISABLED');
  }, 60000);

  it('rollback script: validates the actor, converts every operator account atomically and writes the audit', () => {
    const db = scenarioDb('rollback', migratedDb);
    const admin = user(db, 'admin', 1);
    const manager = user(db, 'manager', 10);
    const active = user(db, 'op-active', 32);
    const inactive = user(db, 'op-inactive', 32, false);
    // An integration row that references the operator: the account cannot be deleted, only reassigned.
    sql(db, `INSERT INTO onec_sources (code, display_name, created_by, updated_by) VALUES ('e2e-src', 'E2E', ${active}, ${active});`);
    sql(db, `INSERT INTO auth_sessions (session_id, user_id, status, expires_at) VALUES (gen_random_uuid(), ${active}, 'active', now() + interval '1 day');`);

    for (const badActor of [manager, active, '999999999']) {
      const refused = rollback(db, badActor);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/not an active admin\/superadmin/);
    }
    expect(sql(db, 'SELECT count(*) FROM users WHERE role_id = 32;')).toBe('2');
    expect(sql(db, 'SELECT is_active FROM roles WHERE role_id = 32;')).toBe('t');
    expect(sql(db, "SELECT count(*) FROM audit_log WHERE source = 'maintenance';")).toBe('0');

    const done = rollback(db, admin);
    expect(done.status, done.stderr).toBe(0);
    expect(done.stderr).toContain('role 32 assignments: 0');
    expect(sql(db, `SELECT string_agg(role_id || ':' || is_active || ':' || edited_by, ',' ORDER BY user_id) FROM users WHERE user_id IN (${active}, ${inactive});`))
      .toBe(`100:false:${admin},100:false:${admin}`);
    expect(sql(db, 'SELECT is_active FROM roles WHERE role_id = 32;')).toBe('f');
    expect(sql(db, `SELECT created_by FROM onec_sources WHERE code = 'e2e-src';`)).toBe(active);
    expect(sql(db, `SELECT status FROM auth_sessions WHERE user_id = ${active};`)).toBe('revoked');

    const audit = sql(db, `
      SELECT event || '|' || entity_type || '|' || entity_id || '|' || user_id || '|' || role_code || '|' || coalesce(related_user_id::text, '-')
             || '|' || (before_json->>'role') || '>' || (after_json->>'role') || '|' || (before_json->>'isActive') || '>' || (after_json->>'isActive')
      FROM audit_log WHERE event = 'users.onec_operator_role_rollback' ORDER BY entity_id::bigint;`).split('\n');
    expect(audit).toEqual([
      `users.onec_operator_role_rollback|user|${active}|${admin}|admin|${active}|onec_operator>viewer|true>false`,
      `users.onec_operator_role_rollback|user|${inactive}|${admin}|admin|${inactive}|onec_operator>viewer|false>false`,
    ]);
    // One operation id for every row; normalized links; no credentials.
    expect(sql(db, "SELECT count(DISTINCT request_id) || '/' || count(*) FROM audit_log WHERE source = 'maintenance';")).toBe('1/3');
    expect(sql(db, "SELECT count(*) FROM audit_log WHERE source = 'maintenance' AND request_id LIKE 'maintenance-onec-operator-rollback-%' AND metadata_json->>'correlationId' = request_id;")).toBe('3');
    expect(sql(db, `SELECT string_agg(l.entity_type || ':' || l.entity_id, ',' ORDER BY l.entity_id) FROM audit_log_related_entity l
      JOIN audit_log a USING (audit_id) WHERE a.event = 'users.onec_operator_role_rollback';`)).toBe(`user:${active},user:${inactive}`);
    expect(sql(db, "SELECT count(*) FROM audit_log WHERE source = 'maintenance' AND (before_json::text || after_json::text || diff_json::text) ~* 'password|hash|@';")).toBe('0');
    expect(sql(db, "SELECT event FROM audit_log WHERE entity_type = 'role' AND source = 'maintenance';")).toBe('roles.onec_operator.disabled');

    // After the rollback nobody can be created with the role; a second run is a no-op that still reports zero.
    expect(psql(db, "INSERT INTO users (username, email, password_hash, role_id) VALUES ('E2E-Тест-after', 'e2e-after@example.invalid', 'x', 32);").stderr)
      .toContain('ONEC_OPERATOR_ROLE_DISABLED');
    expect(rollback(db, admin).status).toBe(0);
    expect(sql(db, "SELECT count(*) FROM audit_log WHERE event = 'users.onec_operator_role_rollback';")).toBe('2');
    // …and does not invent a second «role disabled» transition: the role was already off.
    expect(sql(db, "SELECT count(*) FROM audit_log WHERE event = 'roles.onec_operator.disabled';")).toBe('1');
    expect(sql(db, "SELECT count(*) FROM audit_log WHERE source = 'maintenance';")).toBe('3');
  }, 60000);

  it('rollback script is atomic: a failing audit insert leaves users and the role unchanged', () => {
    const db = scenarioDb('atomic', migratedDb);
    const admin = user(db, 'admin2', 1);
    const operator = user(db, 'op2', 32);
    sql(db, "ALTER TABLE audit_log ADD CONSTRAINT e2e_block_rollback_audit CHECK (event <> 'users.onec_operator_role_rollback');");
    const failed = rollback(db, admin);
    expect(failed.status).not.toBe(0);
    expect(sql(db, `SELECT role_id || ':' || is_active FROM users WHERE user_id = ${operator};`)).toBe('32:true');
    expect(sql(db, 'SELECT is_active FROM roles WHERE role_id = 32;')).toBe('t');
    expect(sql(db, "SELECT count(*) FROM audit_log WHERE source = 'maintenance';")).toBe('0');
  }, 60000);

  it('rollback waits for an in-flight operator creation, converts it too, and later creations are refused', async () => {
    const db = scenarioDb('race', migratedDb);
    const admin = user(db, 'admin3', 1);
    const creator = spawn('docker', ['exec', '-i', container, 'sh', '-lc', PSQL, 'onec-role-creator', db], { stdio: ['pipe', 'pipe', 'pipe'] });
    let creatorErr = '';
    creator.stderr.on('data', (chunk) => { creatorErr += String(chunk); });
    creator.stdin.write("BEGIN; INSERT INTO users (username, email, password_hash, role_id) VALUES ('E2E-Тест-inflight', 'e2e-inflight@example.invalid', 'x', 32);\n");
    let held = false;
    for (let i = 0; i < 40 && !held; i += 1) {
      held = sql(db, "SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'roles' AND l.mode = 'RowShareLock' AND l.granted);") === 't';
      if (!held) await sleep(250);
    }
    expect(held).toBe(true);

    // The rollback blocks on the role row (lock_timeout 10s in the script) until the creation commits.
    const pending = new Promise<{ status: number | null; stderr: string }>((done) => {
      const child = spawn('docker', ['exec', '-i', container, 'sh', '-lc', `${PSQL} -v actor_id="$2"`, 'onec-role-rollback', db, admin], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('close', (status) => done({ status, stderr }));
      child.stdin.end(readFileSync(rollbackPath, 'utf8'));
    });
    await sleep(1500);
    expect(sql(db, 'SELECT is_active FROM roles WHERE role_id = 32;')).toBe('t'); // not committed yet: still waiting
    creator.stdin.end('COMMIT;\n');
    const finished = await pending;
    expect(creatorErr).toBe('');
    expect(finished.status, finished.stderr).toBe(0);
    expect(sql(db, 'SELECT count(*) FROM users WHERE role_id = 32;')).toBe('0');
    expect(sql(db, "SELECT role_id || ':' || is_active FROM users WHERE username = 'E2E-Тест-inflight';")).toBe('100:false');

    const late = psql(db, "INSERT INTO users (username, email, password_hash, role_id) VALUES ('E2E-Тест-late2', 'e2e-late2@example.invalid', 'x', 32);");
    expect(late.stderr).toContain('ONEC_OPERATOR_ROLE_DISABLED');
  }, 60000);

  it('an operator creation that waits behind the role switch-off is refused once the switch-off commits', async () => {
    const db = scenarioDb('waiter', migratedDb);
    // The rollback's first step, held open: the role row is locked and already inactive in that transaction.
    const holder = spawn('docker', ['exec', '-i', container, 'sh', '-lc', PSQL, 'onec-role-holder', db], { stdio: ['pipe', 'pipe', 'pipe'] });
    holder.stdin.write('BEGIN; UPDATE roles SET is_active = false WHERE role_id = 32;\n');
    let locked = false;
    for (let i = 0; i < 40 && !locked; i += 1) {
      locked = sql(db, "SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'roles' AND l.mode = 'RowExclusiveLock' AND l.granted);") === 't';
      if (!locked) await sleep(250);
    }
    expect(locked).toBe(true);

    const waiting = new Promise<{ status: number | null; stderr: string }>((done) => {
      const child = spawn('docker', ['exec', '-i', container, 'sh', '-lc', PSQL, 'onec-role-waiter', db], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('close', (status) => done({ status, stderr }));
      child.stdin.end("INSERT INTO users (username, email, password_hash, role_id) VALUES ('E2E-Тест-waiter', 'e2e-waiter@example.invalid', 'x', 32);\n");
    });
    // The insert is blocked on the role row (FOR SHARE in the trigger), not refused and not applied.
    let blocked = false;
    for (let i = 0; i < 40 && !blocked; i += 1) {
      blocked = sql(db, "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'INSERT INTO users%');") === 't';
      if (!blocked) await sleep(250);
    }
    expect(blocked).toBe(true);
    expect(sql(db, "SELECT count(*) FROM users WHERE username = 'E2E-Тест-waiter';")).toBe('0');

    holder.stdin.end('COMMIT;\n');
    const result = await waiting;
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ONEC_OPERATOR_ROLE_DISABLED');
    expect(sql(db, "SELECT count(*) FROM users WHERE role_id = 32;")).toBe('0');
  }, 60000);
});

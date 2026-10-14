import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '254_trim_text_fields_json_escape.sql'), 'utf8');
const databaseUrl = process.env.TRIM_TEXT_FIELDS_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;

// Only the CREATE OR REPLACE statement: the test runs it inside its own transaction and rolls
// back, so the target database keeps whatever trim_text_fields() it had.
const createFunction = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public.trim_text_fields()'),
  sql.indexOf('$function$;') + '$function$;'.length,
);

const samples = [
  'ТОО "Ромашка"',
  'путь C:\\temp\\x',
  'строка1\nстрока2',
  'a\tb\r\nc',
  '  с пробелами по краям  ',
  '«ёлочки» и эмодзи 🪑',
  'буквально \\u0041 и \\"',
  '',
];

describe('migration 254: trim_text_fields escapes what it trims', () => {
  it('replaces only the string expression of the legacy body, in one transaction', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql).toMatch(/^COMMIT;\s*$/m);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("to_regprocedure('public.trim_text_fields()') IS NULL");
    expect(createFunction).toContain("THEN to_jsonb(btrim(e.v #>> '{}'::text[]))");
    expect(createFunction).not.toMatch(/'"' \|\|/);
    expect(createFunction).toContain("AND attgenerated <> ''");
    expect(createFunction).toContain("NEW := jsonb_populate_record(NEW, COALESCE(j, '{}'::jsonb));");
    // No data or table changes: the body swap is the whole migration.
    expect(sql.replace(/--.*$/gm, '')).not.toMatch(/\b(UPDATE|DELETE|INSERT|ALTER TABLE|DROP)\b/);
  });
});

describe.skipIf(!databaseUrl)('migration 254 on PostgreSQL (rolled back)', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(createFunction);
    await client.query(`CREATE TEMP TABLE trim_probe (
      id integer PRIMARY KEY,
      name text,
      notes text,
      amount numeric,
      shout text GENERATED ALWAYS AS (upper(name)) STORED
    ) ON COMMIT DROP`);
    await client.query(`CREATE TRIGGER trg_trim_probe BEFORE INSERT OR UPDATE ON trim_probe
      FOR EACH ROW EXECUTE FUNCTION public.trim_text_fields()`);
  }, 30000);

  afterAll(async () => {
    if (client) {
      try { await client.query('ROLLBACK'); }
      finally { client.release(); }
    }
    await pool?.end();
  });

  it('stores every string trimmed, with quotes, backslashes and control characters intact', async () => {
    for (const [index, value] of samples.entries()) {
      const { rows } = await client.query<{ name: string; notes: string; shout: string }>(
        'INSERT INTO trim_probe (id, name, notes, amount) VALUES ($1, $2, $2, 1.5) RETURNING name, notes, shout',
        [index, value],
      );
      const trimmed = value.replace(/^ +| +$/g, '');
      expect(rows[0]).toEqual({ name: trimmed, notes: trimmed, shout: trimmed.toUpperCase() });
    }
    const updated = await client.query<{ name: string; amount: string }>(
      `UPDATE trim_probe SET name = $1 WHERE id = 0 RETURNING name, amount::text`,
      ['  ИП "Тест"\n '],
    );
    expect(updated.rows[0]).toEqual({ name: 'ИП "Тест"\n', amount: '1.5' });
  });

  it('keeps NULL and non-string values as they are', async () => {
    const { rows } = await client.query(
      'INSERT INTO trim_probe (id, name, notes, amount) VALUES (100, NULL, NULL, NULL) RETURNING name, notes, amount',
    );
    expect(rows[0]).toEqual({ name: null, notes: null, amount: null });
  });

  it('gives the legacy result for text without backslashes', async () => {
    const safe = ['ТОО Ромашка', '  x  ', '«ёлочки»', '🪑', ''];
    const { rows } = await client.query<{ same: boolean }>(
      `SELECT bool_and(('"' || btrim(v) || '"')::jsonb = to_jsonb(btrim(v))) AS same
         FROM unnest($1::text[]) AS v`,
      [safe],
    );
    expect(rows[0].same).toBe(true);
  });

  it('keeps literal escape sequences that the legacy cast silently decoded', async () => {
    // Intentional change: legacy turned typed `\u0041`, `\n`, `\"`, `\\` into A, newline, ", \.
    const cases: Array<[string, string]> = [
      ['Acme\\u0041', 'AcmeA'],
      ['a\\nb', 'a\nb'],
      ['x \\"y\\"', 'x "y"'],
      ['C:\\\\dir', 'C:\\dir'],
    ];
    for (const [index, [typed, legacy]] of cases.entries()) {
      const before = await client.query<{ decoded: string }>(
        `SELECT ('"' || btrim($1::text) || '"')::jsonb #>> '{}' AS decoded`,
        [typed],
      );
      expect(before.rows[0].decoded).toBe(legacy);
      const after = await client.query<{ name: string }>(
        'INSERT INTO trim_probe (id, name) VALUES ($1, $2) RETURNING name',
        [200 + index, typed],
      );
      expect(after.rows[0].name).toBe(typed);
    }
  });

  it('preserves stored special characters across repeated and unrelated updates', async () => {
    const value = 'ТОО "Ромашка"\nC:\\x\t\\u0041';
    await client.query('INSERT INTO trim_probe (id, name, notes, amount) VALUES (300, $1, $1, 1)', [value]);
    for (let round = 0; round < 3; round++) {
      await client.query('UPDATE trim_probe SET amount = amount + 1 WHERE id = 300');
    }
    const { rows } = await client.query('SELECT name, notes, amount::text FROM trim_probe WHERE id = 300');
    expect(rows[0]).toEqual({ name: value, notes: value, amount: '4' });
  });

  it('lets clients take a name with quotes and a multi-line note and update the row later', async () => {
    await client.query('SAVEPOINT real_table');
    const { rows } = await client.query<{ client_id: number; client_name: string; notes: string }>(
      `INSERT INTO clients (client_name, person_type, notes, is_active)
       VALUES ($1, 'legal', $2, true) RETURNING client_id, client_name, notes`,
      ['  E2E-Тест ТОО "Ромашка" ', 'первая строка\nвторая "строка"'],
    );
    expect(rows[0]).toMatchObject({ client_name: 'E2E-Тест ТОО "Ромашка"', notes: 'первая строка\nвторая "строка"' });
    const updated = await client.query(
      'UPDATE clients SET is_active = false WHERE client_id = $1 RETURNING client_name, notes, is_active',
      [rows[0].client_id],
    );
    expect(updated.rows[0]).toEqual({
      client_name: 'E2E-Тест ТОО "Ромашка"',
      notes: 'первая строка\nвторая "строка"',
      is_active: false,
    });
    await client.query('ROLLBACK TO SAVEPOINT real_table');
  });
});

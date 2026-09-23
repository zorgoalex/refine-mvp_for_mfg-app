/** Test-only helpers for isolated PostgreSQL MDF correction command fixtures. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { PerformanceQueryTelemetryService } from '../../../performance/performance-query-telemetry.service';

const identifier = /^[a-z][a-z0-9_]{0,62}$/;
const safeIdentifier = (value: string) => {
  if (!identifier.test(value)) throw new Error('MDF_TEST_INVALID_IDENTIFIER');
  return `"${value}"`;
};

export interface MdfCorrectionPgFixture {
  readonly schema: string;
  readonly client: Client;
  connect(): Promise<void>;
  applyMigrations(files: readonly string[]): Promise<void>;
  clonePublicTables(tables: readonly string[]): Promise<void>;
  createDatabaseService(): DatabaseService;
  assertLocalRelations(relations: readonly string[]): Promise<void>;
  snapshot(relations: readonly string[]): Promise<Record<string, unknown[]>>;
  drop(): Promise<void>;
}

/**
 * A real-PG fixture that owns only its random schema. Callers must gate their
 * suite with MDF_ENGINE_INTEGRATION=1 and must not mutate public settings.
 */
export function createMdfCorrectionPgFixture(prefix = 'e2e_mdf_correction'): MdfCorrectionPgFixture {
  if (!identifier.test(prefix)) throw new Error('MDF_TEST_INVALID_SCHEMA_PREFIX');
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const client = new Client({
    host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=20000 -c lock_timeout=1000 -c max_parallel_workers_per_gather=0 -c jit=off',
  });
  let connected = false;
  let created = false;

  const assertLocalRelations = async (relations: readonly string[]) => {
    const expected = [...new Set(relations)].sort();
    for (const relation of expected) safeIdentifier(relation);
    const found = (await client.query<{ relname: string }>(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND c.relkind IN ('r','p') ORDER BY c.relname`,
    [schema, expected])).rows.map(row => row.relname);
    if (found.length !== expected.length || found.some((name, index) => name !== expected[index])) {
      throw new Error('MDF_TEST_RELATION_NOT_LOCAL');
    }
  };

  return {
    schema,
    client,
    async connect() {
      if (process.env.MDF_ENGINE_INTEGRATION !== '1') throw new Error('MDF_TEST_INTEGRATION_OPT_IN_REQUIRED');
      await client.connect();
      connected = true;
      await client.query(`CREATE SCHEMA ${safeIdentifier(schema)}; SET search_path=${safeIdentifier(schema)},public`);
      created = true;
      const current = (await client.query<{ current_schema: string }>('SELECT current_schema()')).rows[0]?.current_schema;
      if (current !== schema) throw new Error('MDF_TEST_SEARCH_PATH_NOT_OWNED');
    },
    async applyMigrations(files) {
      if (!created) throw new Error('MDF_TEST_SCHEMA_NOT_CREATED');
      for (const file of files) {
        if (!/^[0-9]{3}_[a-z0-9_]+\.sql$/.test(file)) throw new Error('MDF_TEST_INVALID_MIGRATION_NAME');
        const sql = readFileSync(new URL(`../../../../db/migrations/${file}`, import.meta.url), 'utf8');
        await client.query(sql);
      }
    },
    async clonePublicTables(tables) {
      if (!created) throw new Error('MDF_TEST_SCHEMA_NOT_CREATED');
      for (const table of [...new Set(tables)]) {
        const safe = safeIdentifier(table);
        const exists = (await client.query(`SELECT to_regclass($1) AS relation`, [`${schema}.${table}`])).rows[0]?.relation;
        if (exists) throw new Error('MDF_TEST_CLONE_TARGET_EXISTS');
        await client.query(`CREATE TABLE ${safeIdentifier(schema)}.${safe} AS TABLE public.${safe} WITH NO DATA`);
      }
      await assertLocalRelations(tables);
    },
    createDatabaseService() {
      if (!created) throw new Error('MDF_TEST_SCHEMA_NOT_CREATED');
      const url = new URL('postgresql://localhost');
      url.hostname = process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1';
      url.pathname = `/${process.env.PG_DB ?? ''}`;
      url.username = process.env.PG_USER ?? '';
      url.password = process.env.PG_PASSWORD ?? '';
      url.searchParams.set('options', `-c search_path=${schema},public -c statement_timeout=20000 -c lock_timeout=1000 -c max_parallel_workers_per_gather=0 -c jit=off -c application_name=${schema}`);
      const values: Partial<BackendEnv> = {
        DATABASE_URL: url.toString(), DATABASE_QUERY_TIMEOUT_MS: 20000,
        DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 2, DATABASE_SSL: false,
      };
      return new DatabaseService(
        { get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv, true>,
        { measure: <T>(_sql: string, operation: () => Promise<T>) => operation() } as PerformanceQueryTelemetryService,
      );
    },
    assertLocalRelations,
    async snapshot(relations) {
      await assertLocalRelations(relations);
      const snapshots: Record<string, unknown[]> = {};
      for (const relation of [...new Set(relations)].sort()) {
        const table = safeIdentifier(relation);
        const rows = (await client.query<{ rows: unknown[] }>(`
          SELECT COALESCE(jsonb_agg(to_jsonb(snapshot_row) ORDER BY to_jsonb(snapshot_row)::text),'[]'::jsonb) AS rows
          FROM ${safeIdentifier(schema)}.${table} AS snapshot_row`)).rows[0]?.rows;
        snapshots[relation] = rows ?? [];
      }
      return snapshots;
    },
    async drop() {
      if (!connected) return;
      try {
        if (created) {
          await client.query('ROLLBACK').catch(() => undefined);
          await client.query(`SET search_path=public; DROP SCHEMA IF EXISTS ${safeIdentifier(schema)} CASCADE`);
          const remaining = (await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows;
          if (remaining.length) throw new Error('MDF_TEST_SCHEMA_CLEANUP_FAILED');
          created = false;
        }
      } finally {
        await client.end();
        connected = false;
      }
    },
  };
}

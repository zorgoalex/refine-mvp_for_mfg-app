import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import type { MappingRow } from '../application/crm-sync.types';
import { PgCrmSyncMappingRepository } from './pg-crm-sync-mapping-repository';

// Integration tests for PgCrmSyncMappingRepository.
// Gated on CRM_SYNC_INTEGRATION_DATABASE_URL (falls back to TEST_DATABASE_URL).
// Skips cleanly without a database. Throwaway schema only.
const databaseUrl =
  process.env.CRM_SYNC_INTEGRATION_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

const schemaName = `crm_map_${randomUUID().replaceAll('-', '_')}`;

async function createSchema(client: import('pg').PoolClient): Promise<void> {
  await client.query(`CREATE SCHEMA ${schemaName}`);
  await client.query(`SET search_path TO ${schemaName}`);
  await client.query(`
    CREATE TABLE ${schemaName}.crm_sync_mapping (
      entity_type   TEXT NOT NULL CHECK (entity_type IN ('client','order','payment')),
      erp_id        TEXT NOT NULL,
      bitrix_object TEXT NOT NULL,
      bitrix_id     TEXT,
      parent_erp_id TEXT,
      status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted','failed')),
      attempts      INTEGER NOT NULL DEFAULT 0,
      last_hash     TEXT,
      last_error    TEXT,
      last_synced_at TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT pk_crm_sync_mapping PRIMARY KEY (entity_type, erp_id),
      CONSTRAINT uq_crm_sync_mapping_bitrix UNIQUE (entity_type, bitrix_object, bitrix_id)
    )
  `);
}

/** Minimal DatabaseClient backed by a pool in the throwaway schema. */
function makeClient(pool: Pool): DatabaseClient {
  return {
    query: (text: string, params: readonly unknown[] = []) => pool.query(text, [...params]),
  };
}

describeIntegration('PgCrmSyncMappingRepository (integration)', () => {
  let pool: Pool;
  let repo: PgCrmSyncMappingRepository;
  let client: DatabaseClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    // Pin search_path for EVERY pooled connection (including the setup client).
    // Must be registered before any pool.connect() / pool.query() call so that
    // the very first connection also gets the correct search_path.
    pool.on('connect', (c) => void c.query(`SET search_path TO ${schemaName}`));
    // Use a single dedicated client for schema setup.
    const setupClient = await pool.connect();
    try {
      await createSchema(setupClient);
    } finally {
      setupClient.release();
    }
    repo = new PgCrmSyncMappingRepository();
    client = makeClient(pool);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.end();
    }
  });

  // ── get returns null for unknown key ──────────────────────────────────────

  it('get returns null for an unknown key', async () => {
    const result = await repo.get(client, 'client', '9999');
    expect(result).toBeNull();
  });

  // ── upsertSuccess then get returns the row ────────────────────────────────

  it('upsertSuccess inserts and get returns the row', async () => {
    const row: MappingRow = {
      entityType: 'client',
      erpId: '1',
      bitrixObject: 'contact',
      bitrixId: '101',
      parentErpId: null,
      status: 'active',
      lastHash: 'hash1',
    };
    await repo.upsertSuccess(client, row);
    const fetched = await repo.get(client, 'client', '1');
    expect(fetched).not.toBeNull();
    expect(fetched!.entityType).toBe('client');
    expect(fetched!.erpId).toBe('1');
    expect(fetched!.bitrixObject).toBe('contact');
    expect(fetched!.bitrixId).toBe('101');
    expect(fetched!.parentErpId).toBeNull();
    expect(fetched!.status).toBe('active');
    expect(fetched!.lastHash).toBe('hash1');
  });

  // ── upsertSuccess again updates and resets attempts/last_error ────────────

  it('upsertSuccess again updates Bitrix ID/status/hash and resets failure state', async () => {
    // First insert a failed record manually to verify reset.
    await repo.markFailed(client, 'client', '1', 'person', 'some error');
    // Now upsert success — should reset.
    const row: MappingRow = {
      entityType: 'client',
      erpId: '1',
      bitrixObject: 'contact',
      bitrixId: '102',
      parentErpId: null,
      status: 'active',
      lastHash: 'hash2',
    };
    await repo.upsertSuccess(client, row);
    const fetched = await repo.get(client, 'client', '1');
    expect(fetched).not.toBeNull();
    expect(fetched!.bitrixId).toBe('102');
    expect(fetched!.lastHash).toBe('hash2');
    expect(fetched!.status).toBe('active');
    // Verify attempts=0 and last_error=null via raw query.
    const raw = await pool.query(
      `SELECT attempts, last_error FROM ${schemaName}.crm_sync_mapping WHERE entity_type=$1 AND erp_id=$2`,
      ['client', '1'],
    );
    expect(raw.rows[0].attempts).toBe(0);
    expect(raw.rows[0].last_error).toBeNull();
  });

  // ── markFailed on fresh key inserts status=failed attempts=1 ─────────────

  it('markFailed on a fresh key inserts status=failed attempts=1 last_error set', async () => {
    await repo.markFailed(client, 'order', '100', 'deal', 'connection refused');
    const raw = await pool.query(
      `SELECT status, attempts, last_error FROM ${schemaName}.crm_sync_mapping WHERE entity_type=$1 AND erp_id=$2`,
      ['order', '100'],
    );
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0].status).toBe('failed');
    expect(raw.rows[0].attempts).toBe(1);
    expect(raw.rows[0].last_error).toBe('connection refused');
  });

  // ── markFailed again increments attempts to 2 ────────────────────────────

  it('markFailed again on same key increments attempts to 2 and keeps status=failed', async () => {
    await repo.markFailed(client, 'order', '100', 'deal', 'timeout');
    const raw = await pool.query(
      `SELECT status, attempts, last_error FROM ${schemaName}.crm_sync_mapping WHERE entity_type=$1 AND erp_id=$2`,
      ['order', '100'],
    );
    expect(raw.rows[0].status).toBe('failed');
    expect(raw.rows[0].attempts).toBe(2);
    expect(raw.rows[0].last_error).toBe('timeout');
  });
});

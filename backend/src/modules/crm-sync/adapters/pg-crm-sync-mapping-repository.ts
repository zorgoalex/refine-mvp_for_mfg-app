import type { DatabaseClient } from '../../../database/database.types';
import type { MappingRow } from '../application/crm-sync.types';

export class PgCrmSyncMappingRepository {
  async get(
    client: DatabaseClient,
    entityType: string,
    erpId: string,
  ): Promise<MappingRow | null> {
    const result = await client.query<{
      entity_type: string;
      erp_id: string;
      twenty_object: string;
      twenty_id: string | null;
      status: string;
      last_hash: string | null;
    }>(
      `SELECT entity_type, erp_id, twenty_object, twenty_id, status, last_hash
         FROM crm_sync_mapping
        WHERE entity_type=$1 AND erp_id=$2`,
      [entityType, erpId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      entityType: row.entity_type,
      erpId: row.erp_id,
      twentyObject: row.twenty_object,
      twentyId: row.twenty_id ?? null,
      status: row.status,
      lastHash: row.last_hash ?? null,
    };
  }

  async upsertSuccess(client: DatabaseClient, row: MappingRow): Promise<void> {
    await client.query(
      `INSERT INTO crm_sync_mapping (entity_type, erp_id, twenty_object, twenty_id, status, last_hash, last_error, attempts, last_synced_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,0, now(), now())
       ON CONFLICT (entity_type, erp_id) DO UPDATE SET
         twenty_id=EXCLUDED.twenty_id, status=EXCLUDED.status, last_hash=EXCLUDED.last_hash,
         last_error=NULL, attempts=0, last_synced_at=now(), updated_at=now()`,
      [row.entityType, row.erpId, row.twentyObject, row.twentyId, row.status, row.lastHash],
    );
  }

  async markFailed(
    client: DatabaseClient,
    entityType: string,
    erpId: string,
    twentyObject: string,
    error: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO crm_sync_mapping (entity_type, erp_id, twenty_object, status, last_error, attempts, updated_at)
       VALUES ($1,$2,$3,'failed',$4,1, now())
       ON CONFLICT (entity_type, erp_id) DO UPDATE SET
         status='failed', last_error=EXCLUDED.last_error, attempts=crm_sync_mapping.attempts+1, updated_at=now()`,
      [entityType, erpId, twentyObject, error.slice(0, 1000)],
    );
  }
}

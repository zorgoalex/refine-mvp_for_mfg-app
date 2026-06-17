import type { DatabaseClient } from '../../database/database.types';

export interface AuditRelatedEntity { entityType: string; entityId: number }

export async function insertRelatedEntities(
  client: DatabaseClient,
  auditId: string,
  entities: readonly AuditRelatedEntity[],
): Promise<void> {
  const seen = new Set<string>();
  for (const e of entities) {
    if (!Number.isFinite(e.entityId)) continue;        // numeric ids only (BIGINT)
    const key = `${e.entityType}:${e.entityId}`;
    if (seen.has(key)) continue;                        // dedupe
    seen.add(key);
    await client.query(
      `INSERT INTO audit_log_related_entity (audit_id, entity_type, entity_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [auditId, e.entityType, e.entityId],
    );
  }
}

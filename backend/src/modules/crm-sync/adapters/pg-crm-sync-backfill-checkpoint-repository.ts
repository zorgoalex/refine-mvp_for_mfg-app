import type { DatabaseService } from '../../../database/database.service';
import type {
  DatabaseClient,
  TransactionClient,
} from '../../../database/database.types';
import type {
  BackfillCheckpoint,
  BackfillPhase,
  BackfillScope,
} from '../application/crm-sync-backfill';

interface CheckpointRow {
  scope: BackfillScope;
  phase: BackfillPhase;
  last_client_id: string | null;
  last_order_id: string | null;
  processed_clients: string | number;
  processed_orders: string | number;
}

export class PgCrmSyncBackfillCheckpointRepository {
  async load(
    db: DatabaseService,
    scope: BackfillScope,
  ): Promise<BackfillCheckpoint | null> {
    const { rows } = await db.query<CheckpointRow>(
      `SELECT scope, phase, last_client_id, last_order_id,
              processed_clients, processed_orders
         FROM crm_sync_backfill_checkpoint
        WHERE scope = $1`,
      [scope],
    );
    const row = rows[0];
    if (!row) return null;

    return {
      scope: row.scope,
      phase: row.phase,
      lastClientId: row.last_client_id,
      lastOrderId: row.last_order_id,
      processedClients: safeCount(row.processed_clients, 'processed_clients'),
      processedOrders: safeCount(row.processed_orders, 'processed_orders'),
    };
  }

  async save(
    tx: TransactionClient,
    checkpoint: BackfillCheckpoint,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO crm_sync_backfill_checkpoint (
         scope,
         phase,
         last_client_id,
         last_order_id,
         processed_clients,
         processed_orders,
         completed_at
       )
       VALUES ($1, $2, $3, $4, $5, $6,
         CASE WHEN $2 = 'completed' THEN now() ELSE NULL END
       )
       ON CONFLICT (scope) DO UPDATE SET
         phase = EXCLUDED.phase,
         last_client_id = EXCLUDED.last_client_id,
         last_order_id = EXCLUDED.last_order_id,
         processed_clients = EXCLUDED.processed_clients,
         processed_orders = EXCLUDED.processed_orders,
         updated_at = now(),
         completed_at = CASE
           WHEN EXCLUDED.phase = 'completed' THEN now()
           ELSE NULL
         END`,
      [
        checkpoint.scope,
        checkpoint.phase,
        checkpoint.lastClientId,
        checkpoint.lastOrderId,
        checkpoint.processedClients,
        checkpoint.processedOrders,
      ],
    );
  }

  async reset(
    db: DatabaseClient,
    scope: BackfillScope,
  ): Promise<void> {
    await db.query(
      'DELETE FROM crm_sync_backfill_checkpoint WHERE scope = $1',
      [scope],
    );
  }
}

function safeCount(value: string | number, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${field} in Bitrix24 backfill checkpoint`);
  }
  return parsed;
}

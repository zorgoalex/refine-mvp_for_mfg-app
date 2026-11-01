import type { TransactionClient } from '../../database/database.types';

/**
 * Marks the transaction as a backend writer of production_status_events.
 * The DB command boundary (migration B of «Переделка») rejects INSERT/UPDATE/
 * DELETE on stage events without this marker, so direct Hasura/SQL writes
 * cannot bypass production rounds. `historical_import` additionally allows the
 * original round_no of imported events (order snapshot import only).
 */
export async function markStageEventWriter(
  tx: TransactionClient,
  mode: 'backend' | 'historical_import' = 'backend',
): Promise<void> {
  await tx.query("SELECT set_config('erp.pse_writer', $1, true)", [mode]);
}

import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';
import type { CncTelegramWorkerSessionLeaseContext } from '../application/cnc-telegram-worker-session.types';

/**
 * The global session check belongs in the same transaction as every worker
 * mutation. The advisory lane lock serializes this check with claim/reclaim;
 * FOR SHARE then holds the current lease row until the mutation commits.
 */
export async function assertCurrentWorkerSessionInTransaction(
  tx: TransactionClient,
  lease: CncTelegramWorkerSessionLeaseContext,
): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [lease.sourceChatId]);
  const result = await tx.query<{ lease_token: string }>(`
    SELECT lease_token
      FROM cnc_telegram_worker_session_leases
     WHERE source_chat_id=$1
       AND lease_token=$2
       AND lease_generation=$3
       AND worker_instance_id=$4::uuid
       AND expires_at > now()
     FOR SHARE
  `, [lease.sourceChatId, lease.leaseToken, lease.leaseGeneration, lease.workerInstanceId]);
  if (!result.rows[0]) {
    throw new ApiError(409, 'CNC_TELEGRAM_SESSION_LEASE_STALE', 'Telegram worker session lease is stale or expired');
  }
}

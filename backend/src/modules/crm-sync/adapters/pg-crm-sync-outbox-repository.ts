import type { DatabaseClient } from '../../../database/database.types';
import type { OutboxEventRecord } from '../../notifications-engine/domain/outbox-event.types';

export type ClaimedCrmSyncOutboxEvent = OutboxEventRecord & { lockToken: string };

interface OutboxRow {
  outbox_event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload_json: Record<string, unknown> | null;
  attempts: number | string;
  lock_token: string | null;
}

export class PgCrmSyncOutboxRepository {
  async acquireWriterLock(
    client: DatabaseClient,
    lockToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO crm_sync_writer_lock (lock_name, lock_token, locked_at)
       VALUES ('bitrix24-live-writer', $1, now())
       ON CONFLICT (lock_name) DO UPDATE SET
         lock_token=EXCLUDED.lock_token,
         locked_at=EXCLUDED.locked_at
       WHERE crm_sync_writer_lock.locked_at < now() - ($2 * interval '1 millisecond')
          OR crm_sync_writer_lock.lock_token = EXCLUDED.lock_token`,
      [lockToken, leaseMs],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async heartbeatWriterLock(
    client: DatabaseClient,
    lockToken: string,
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE crm_sync_writer_lock
          SET locked_at=now()
        WHERE lock_name='bitrix24-live-writer' AND lock_token=$1`,
      [lockToken],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async releaseWriterLock(
    client: DatabaseClient,
    lockToken: string,
  ): Promise<void> {
    await client.query(
      `DELETE FROM crm_sync_writer_lock
        WHERE lock_name='bitrix24-live-writer' AND lock_token=$1`,
      [lockToken],
    );
  }

  async heartbeat(
    client: DatabaseClient,
    outboxEventId: string,
    lockToken: string,
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE crm_sync_outbox
          SET locked_at=now()
        WHERE outbox_event_id=$1 AND lock_token=$2 AND status='processing'`,
      [outboxEventId, lockToken],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /**
   * Claims a batch of pending (due now) or stale-lease (processing with expired lock)
   * rows from crm_sync_outbox, assigning a fresh lock_token to each.
   * Returns the claimed rows including their new lock_token.
   */
  async claimBatch(
    client: DatabaseClient,
    workerId: string,
    batchSize: number,
    leaseMs: number,
  ): Promise<ClaimedCrmSyncOutboxEvent[]> {
    const result = await client.query<OutboxRow>(
      `UPDATE crm_sync_outbox
       SET status='processing', locked_at=now(), locked_by=$2, lock_token=gen_random_uuid()
       WHERE outbox_event_id IN (
         SELECT outbox_event_id FROM crm_sync_outbox
         WHERE (status='pending' AND next_attempt_at <= now())
            OR (status='processing' AND locked_at < now() - ($3 * interval '1 millisecond'))
         ORDER BY next_attempt_at, created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING outbox_event_id, event_type, aggregate_type, aggregate_id, payload_json, attempts, lock_token`,
      [batchSize, workerId, leaseMs],
    );
    return result.rows.map((row) => ({
      outboxEventId: String(row.outbox_event_id),
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: row.payload_json ?? {},
      attempts: Number(row.attempts),
      lockToken: String(row.lock_token),
    }));
  }

  /**
   * Marks a row as processed ONLY IF it still belongs to this worker (lock_token matches).
   * Returns the number of affected rows (0 = row was reclaimed by another owner).
   */
  async markProcessed(
    client: DatabaseClient,
    outboxEventId: string,
    lockToken: string,
  ): Promise<number> {
    const result = await client.query(
      `UPDATE crm_sync_outbox
       SET status='processed', processed_at=now(), locked_at=NULL, locked_by=NULL
       WHERE outbox_event_id=$1 AND lock_token=$2 AND status='processing'`,
      [outboxEventId, lockToken],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Marks a row for retry (or failed if maxAttempts reached) ONLY IF lock_token matches.
   * Returns the number of affected rows (0 = row was reclaimed by another owner).
   */
  async markRetry(
    client: DatabaseClient,
    outboxEventId: string,
    lockToken: string,
    nextAttemptAt: string,
    maxAttempts: number,
  ): Promise<number> {
    const result = await client.query(
      `UPDATE crm_sync_outbox
       SET attempts=attempts+1, next_attempt_at=$3::timestamptz,
           status=CASE WHEN attempts+1 >= $4 THEN 'failed' ELSE 'pending' END,
           locked_at=NULL, locked_by=NULL, lock_token=NULL
       WHERE outbox_event_id=$1 AND lock_token=$2 AND status='processing'`,
      [outboxEventId, lockToken, nextAttemptAt, maxAttempts],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Read-only preview of pending events due now — used for dry-run.
   * Does NOT lock rows or change status.
   */
  async peekPending(
    client: DatabaseClient,
    limit: number,
  ): Promise<OutboxEventRecord[]> {
    const result = await client.query<OutboxRow>(
      `SELECT outbox_event_id, event_type, aggregate_type, aggregate_id, payload_json, attempts
       FROM crm_sync_outbox
       WHERE status='pending' AND next_attempt_at <= now()
       ORDER BY next_attempt_at, created_at
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      outboxEventId: String(row.outbox_event_id),
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: row.payload_json ?? {},
      attempts: Number(row.attempts),
    }));
  }
}

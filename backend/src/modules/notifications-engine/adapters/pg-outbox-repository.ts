import type { DatabaseClient } from '../../../database/database.types';
import type { OutboxEventRecord } from '../domain/outbox-event.types';
import type { ClaimBatchInput, MarkRetryInput, OutboxRepositoryPort } from '../ports/outbox-repository.port';

interface OutboxEventRow {
  outbox_event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload_json: Record<string, unknown> | null;
  attempts: number | string;
}

export class PgOutboxRepository implements OutboxRepositoryPort {
  async claimPendingBatch(client: DatabaseClient, input: ClaimBatchInput): Promise<OutboxEventRecord[]> {
    const result = await client.query<OutboxEventRow>(
      `UPDATE public.outbox_events
       SET status = 'processing', locked_at = $3::timestamptz, locked_by = $2
       WHERE outbox_event_id IN (
         SELECT outbox_event_id FROM public.outbox_events
         WHERE status = 'pending' AND next_attempt_at <= $3::timestamptz
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING outbox_event_id, event_type, aggregate_type, aggregate_id, payload_json, attempts`,
      [input.batchSize, input.workerId, input.now],
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

  async markProcessed(client: DatabaseClient, outboxEventId: string): Promise<void> {
    await client.query(
      `UPDATE public.outbox_events
       SET status = 'processed', processed_at = now(), locked_at = NULL, locked_by = NULL
       WHERE outbox_event_id = $1`,
      [outboxEventId],
    );
  }

  async markRetry(client: DatabaseClient, outboxEventId: string, input: MarkRetryInput): Promise<{ status: 'pending' | 'failed'; attempts: number }> {
    const result = await client.query<{ status: 'pending' | 'failed'; attempts: number | string }>(
      `UPDATE public.outbox_events
       SET attempts = attempts + 1,
           next_attempt_at = $2::timestamptz,
           status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
           locked_at = NULL, locked_by = NULL
       WHERE outbox_event_id = $1
       RETURNING status, attempts`,
      [outboxEventId, input.nextAttemptAt, input.maxAttempts],
    );
    const row = result.rows[0];
    return { status: row.status, attempts: Number(row.attempts) };
  }
}

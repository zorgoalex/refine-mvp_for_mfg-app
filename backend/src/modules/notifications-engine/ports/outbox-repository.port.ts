import type { DatabaseClient } from '../../../database/database.types';
import type { OutboxEventRecord } from '../domain/outbox-event.types';

export interface ClaimBatchInput {
  batchSize: number;
  workerId: string;
  now: Date;
}

export interface MarkRetryInput {
  nextAttemptAt: Date;
  maxAttempts: number;
}

export interface OutboxRepositoryPort {
  claimPendingBatch(client: DatabaseClient, input: ClaimBatchInput): Promise<OutboxEventRecord[]>;
  markProcessed(client: DatabaseClient, outboxEventId: string): Promise<void>;
  markRetry(client: DatabaseClient, outboxEventId: string, input: MarkRetryInput): Promise<{ status: 'pending' | 'failed'; attempts: number }>;
}

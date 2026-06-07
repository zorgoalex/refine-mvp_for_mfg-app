import type { DatabaseClient } from '../../../database/database.types';
import type { OutboxEventRecord } from '../domain/outbox-event.types';
import type { OutboxRepositoryPort } from '../ports/outbox-repository.port';

export interface OutboxConsumer {
  supports(eventType: string): boolean;
  process(client: DatabaseClient, event: OutboxEventRecord): Promise<void>;
}

/**
 * Minimal database dependency: a pool-backed client for reads plus a
 * transaction runner. Kept narrow so fakes in tests are trivial to build
 * while `DatabaseService` still satisfies this shape directly.
 */
export interface OutboxRelayDatabase {
  query: DatabaseClient['query'];
  transaction<T>(handler: (client: DatabaseClient) => Promise<T>): Promise<T>;
}

export interface OutboxRelayConfig {
  workerId: string;
  batchSize: number;
  maxAttempts: number;
}

export interface OutboxRelaySummary {
  claimed: number;
  processed: number;
  failed: number;
}

export interface OutboxRelayDeps {
  database: OutboxRelayDatabase;
  outboxRepo: OutboxRepositoryPort;
  consumers: OutboxConsumer[];
  config: OutboxRelayConfig;
  now?: () => Date; // injectable clock for tests
  logger?: { warn?: (msg: string, meta?: unknown) => void; error?: (msg: string, meta?: unknown) => void };
}

const MAX_BACKOFF_SECONDS = 3600;

/**
 * Generic outbox relay: claims a batch of pending events, dispatches each one
 * to the consumers that support its `eventType`, and marks it processed — all
 * inside a SINGLE transaction PER EVENT. A failure in one event's transaction
 * rolls back only that event's side effects and never touches a sibling
 * event's transaction. On failure, `markRetry` runs OUTSIDE the rolled-back
 * transaction (directly on `database`) so the retry bookkeeping survives the
 * rollback.
 */
export class OutboxRelayService {
  constructor(private readonly deps: OutboxRelayDeps) {}

  async processBatchOnce(): Promise<OutboxRelaySummary> {
    const now = (this.deps.now ?? (() => new Date()))();
    const batch = await this.deps.outboxRepo.claimPendingBatch(this.deps.database, {
      batchSize: this.deps.config.batchSize,
      workerId: this.deps.config.workerId,
      now,
    });

    let processed = 0;
    let failed = 0;

    for (const event of batch) {
      try {
        await this.deps.database.transaction(async (client) => {
          for (const consumer of this.deps.consumers) {
            if (consumer.supports(event.eventType)) {
              await consumer.process(client, event);
            }
          }
          await this.deps.outboxRepo.markProcessed(client, event.outboxEventId);
        });
        processed += 1;
      } catch (error) {
        failed += 1;
        const backoffSeconds = Math.min(2 ** event.attempts, MAX_BACKOFF_SECONDS);
        const nextAttemptAt = new Date(now.getTime() + backoffSeconds * 1000);
        try {
          await this.deps.outboxRepo.markRetry(this.deps.database, event.outboxEventId, {
            nextAttemptAt,
            maxAttempts: this.deps.config.maxAttempts,
          });
        } catch (retryError) {
          this.deps.logger?.error?.('outbox-relay markRetry failed', {
            outboxEventId: event.outboxEventId,
            retryError,
          });
        }
        this.deps.logger?.warn?.('outbox-relay event failed', {
          outboxEventId: event.outboxEventId,
          eventType: event.eventType,
          error,
        });
      }
    }

    return { claimed: batch.length, processed, failed };
  }
}

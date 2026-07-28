import type { QueryResultRow } from 'pg';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';

export interface TelegramBinding {
  userId: string;
  destination: string;
  displayName: string | null;
  linkedAt: string;
}

export interface TelegramDelivery {
  deliveryId: string;
  userId: string;
  title: string;
  message: string;
  attempts: number;
}

export interface TelegramStaleRecoverySummary {
  rescheduled: number;
  failed: number;
  unknown: number;
}

interface BindingRow extends QueryResultRow {
  user_id: string;
  destination: string;
  display_name: string | null;
  linked_at: Date | string;
}

interface DeliveryRow extends QueryResultRow {
  notification_channel_delivery_id: string;
  user_id: string;
  title: string;
  message: string;
  attempts: number;
}

interface StaleRecoveryRow extends QueryResultRow {
  rescheduled: string | number;
  failed: string | number;
  unknown: string | number;
}

export class PgTelegramNotificationsRepository {
  constructor(private readonly database: DatabaseClient) {}

  async findBindingByUserId(userId: string): Promise<TelegramBinding | null> {
    return findBinding(this.database, userId);
  }

  async createLinkToken(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.database.query(
      `
      UPDATE notification_channel_link_tokens
      SET revoked_at = now()
      WHERE user_id = $1
        AND channel = 'telegram'
        AND consumed_at IS NULL
        AND revoked_at IS NULL
      `,
      [input.userId],
    );
    await this.database.query(
      `
      INSERT INTO notification_channel_link_tokens (user_id, channel, token_hash, expires_at)
      VALUES ($1, 'telegram', $2, $3)
      `,
      [input.userId, input.tokenHash, input.expiresAt.toISOString()],
    );
  }

  async unlink(userId: string): Promise<boolean> {
    const result = await this.database.query(
      `
      DELETE FROM notification_channel_bindings
      WHERE user_id = $1 AND channel = 'telegram'
      `,
      [userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async consumeTelegramStart(
    tx: TransactionClient,
    input: {
      updateId: string;
      tokenHash: string;
      externalUserId: string;
      destination: string;
      displayName: string | null;
      metadata: Record<string, unknown>;
    },
  ): Promise<{ kind: 'linked'; userId: string } | { kind: 'ignored' | 'invalid' | 'conflict' }> {
    const update = await tx.query(
      `
      INSERT INTO telegram_notification_webhook_updates (update_id)
      VALUES ($1)
      ON CONFLICT (update_id) DO NOTHING
      RETURNING update_id
      `,
      [input.updateId],
    );
    if (!update.rows[0]) return { kind: 'ignored' };

    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `telegram:${input.destination}`,
    ]);

    const token = await tx.query<{ notification_channel_link_token_id: string; user_id: string }>(
      `
      SELECT notification_channel_link_token_id, user_id
      FROM notification_channel_link_tokens
      WHERE channel = 'telegram'
        AND token_hash = $1
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      FOR UPDATE
      `,
      [input.tokenHash],
    );
    const tokenRow = token.rows[0];
    if (!tokenRow) {
      await markUpdateProcessed(tx, input.updateId);
      return { kind: 'invalid' };
    }

    const conflict = await tx.query<{ user_id: string }>(
      `
      SELECT user_id
      FROM notification_channel_bindings
      WHERE channel = 'telegram'
        AND (external_user_id = $1 OR destination = $2)
        AND user_id <> $3
      LIMIT 1
      `,
      [input.externalUserId, input.destination, tokenRow.user_id],
    );
    if (conflict.rows[0]) {
      await tx.query(
        `
        UPDATE notification_channel_link_tokens
        SET consumed_at = now()
        WHERE notification_channel_link_token_id = $1
        `,
        [tokenRow.notification_channel_link_token_id],
      );
      await markUpdateProcessed(tx, input.updateId);
      return { kind: 'conflict' };
    }

    await tx.query(
      `
      INSERT INTO notification_channel_bindings (
        user_id, channel, external_user_id, destination, display_name, metadata_json
      )
      VALUES ($1, 'telegram', $2, $3, $4, $5::jsonb)
      ON CONFLICT (user_id, channel) DO UPDATE SET
        external_user_id = EXCLUDED.external_user_id,
        destination = EXCLUDED.destination,
        display_name = EXCLUDED.display_name,
        metadata_json = EXCLUDED.metadata_json,
        linked_at = now(),
        updated_at = now()
      `,
      [
        tokenRow.user_id,
        input.externalUserId,
        input.destination,
        input.displayName,
        JSON.stringify(input.metadata),
      ],
    );
    await tx.query(
      `
      UPDATE notification_channel_link_tokens
      SET consumed_at = now()
      WHERE notification_channel_link_token_id = $1
      `,
      [tokenRow.notification_channel_link_token_id],
    );
    await markUpdateProcessed(tx, input.updateId);
    return { kind: 'linked', userId: String(tokenRow.user_id) };
  }

  async markWebhookUpdateProcessed(updateId: string): Promise<boolean> {
    const result = await this.database.query(
      `
      INSERT INTO telegram_notification_webhook_updates (update_id, processed_at)
      VALUES ($1, now())
      ON CONFLICT (update_id) DO NOTHING
      RETURNING update_id
      `,
      [updateId],
    );
    return Boolean(result.rows[0]);
  }

  async recoverStaleProcessing(
    staleBefore: Date,
    maxAttempts: number,
  ): Promise<TelegramStaleRecoverySummary> {
    const result = await this.database.query<StaleRecoveryRow>(
      `
      WITH recovered AS (
        UPDATE notification_channel_deliveries
        SET status = CASE
              WHEN send_started_at IS NOT NULL THEN 'unknown'
              WHEN attempts >= $2 THEN 'failed'
              ELSE 'pending'
            END,
            next_attempt_at = CASE
              WHEN send_started_at IS NULL AND attempts < $2 THEN now()
              ELSE next_attempt_at
            END,
            last_error_code = CASE
              WHEN send_started_at IS NOT NULL THEN 'STALE_PROCESSING_OUTCOME_UNKNOWN'
              WHEN attempts >= $2 THEN 'TELEGRAM_PRE_SEND_RETRY_EXHAUSTED'
              ELSE 'TELEGRAM_PRE_SEND_STALE_RETRY'
            END,
            last_error_message = CASE
              WHEN send_started_at IS NOT NULL
                THEN 'Worker stopped after send may have started; automatic resend disabled'
              WHEN attempts >= $2
                THEN 'Worker stopped before send and retry limit was exhausted'
              ELSE 'Worker stopped before send; delivery returned to pending'
            END,
            send_started_at = CASE
              WHEN send_started_at IS NULL AND attempts < $2 THEN NULL
              ELSE send_started_at
            END,
            locked_at = NULL,
            locked_by = NULL,
            updated_at = now()
        WHERE channel = 'telegram'
          AND status = 'processing'
          AND locked_at < $1
        RETURNING status
      )
      SELECT
        count(*) FILTER (WHERE status = 'pending') AS rescheduled,
        count(*) FILTER (WHERE status = 'failed') AS failed,
        count(*) FILTER (WHERE status = 'unknown') AS unknown
      FROM recovered
      `,
      [staleBefore.toISOString(), maxAttempts],
    );
    const row = result.rows[0];
    return {
      rescheduled: Number(row?.rescheduled ?? 0),
      failed: Number(row?.failed ?? 0),
      unknown: Number(row?.unknown ?? 0),
    };
  }

  async claimPending(input: {
    workerId: string;
    batchSize: number;
    maxAttempts: number;
  }): Promise<TelegramDelivery[]> {
    const result = await this.database.query<DeliveryRow>(
      `
      WITH candidates AS (
        SELECT notification_channel_delivery_id
        FROM notification_channel_deliveries
        WHERE channel = 'telegram'
          AND status = 'pending'
          AND next_attempt_at <= now()
          AND attempts < $2
        ORDER BY next_attempt_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE notification_channel_deliveries AS delivery
      SET status = 'processing',
          attempts = delivery.attempts + 1,
          locked_at = now(),
          locked_by = $3,
          send_started_at = NULL,
          updated_at = now()
      FROM candidates
      WHERE delivery.notification_channel_delivery_id = candidates.notification_channel_delivery_id
      RETURNING delivery.notification_channel_delivery_id,
                delivery.user_id,
                delivery.title,
                delivery.message,
                delivery.attempts
      `,
      [input.batchSize, input.maxAttempts, input.workerId],
    );
    return result.rows.map((row) => ({
      deliveryId: String(row.notification_channel_delivery_id),
      userId: String(row.user_id),
      title: row.title,
      message: row.message,
      attempts: Number(row.attempts),
    }));
  }

  async findDestination(userId: string): Promise<string | null> {
    return (await findBinding(this.database, userId))?.destination ?? null;
  }

  async markSendStarted(deliveryId: string): Promise<boolean> {
    const result = await this.database.query(
      `
      UPDATE notification_channel_deliveries
      SET send_started_at = now(),
          updated_at = now()
      WHERE notification_channel_delivery_id = $1
        AND status = 'processing'
        AND send_started_at IS NULL
      RETURNING notification_channel_delivery_id
      `,
      [deliveryId],
    );
    return Boolean(result.rows[0]);
  }

  async markDelivered(deliveryId: string, externalMessageId: string): Promise<void> {
    await this.complete(deliveryId, {
      status: 'delivered',
      externalMessageId,
      errorCode: null,
      errorMessage: null,
    });
  }

  async markSkipped(deliveryId: string, code: string, message: string): Promise<void> {
    await this.complete(deliveryId, {
      status: 'skipped',
      externalMessageId: null,
      errorCode: code,
      errorMessage: message,
    });
  }

  async markFailed(deliveryId: string, code: string, message: string): Promise<void> {
    await this.complete(deliveryId, {
      status: 'failed',
      externalMessageId: null,
      errorCode: code,
      errorMessage: message,
    });
  }

  async markUnknown(deliveryId: string, code: string, message: string): Promise<void> {
    await this.complete(deliveryId, {
      status: 'unknown',
      externalMessageId: null,
      errorCode: code,
      errorMessage: message,
    });
  }

  async rescheduleRateLimited(
    deliveryId: string,
    retryAt: Date,
    code: string,
    message: string,
  ): Promise<void> {
    await this.database.query(
      `
      UPDATE notification_channel_deliveries
      SET status = 'pending',
          next_attempt_at = $2,
          locked_at = NULL,
          locked_by = NULL,
          send_started_at = NULL,
          last_error_code = $3,
          last_error_message = $4,
          updated_at = now()
      WHERE notification_channel_delivery_id = $1 AND status = 'processing'
      `,
      [deliveryId, retryAt.toISOString(), code, message.slice(0, 500)],
    );
  }

  async reschedulePreSendFailure(
    deliveryId: string,
    retryAt: Date,
    code: string,
    message: string,
  ): Promise<void> {
    await this.database.query(
      `
      UPDATE notification_channel_deliveries
      SET status = 'pending',
          next_attempt_at = $2,
          locked_at = NULL,
          locked_by = NULL,
          send_started_at = NULL,
          last_error_code = $3,
          last_error_message = $4,
          updated_at = now()
      WHERE notification_channel_delivery_id = $1
        AND status = 'processing'
        AND send_started_at IS NULL
      `,
      [deliveryId, retryAt.toISOString(), code, message.slice(0, 500)],
    );
  }

  private async complete(
    deliveryId: string,
    input: {
      status: 'delivered' | 'skipped' | 'failed' | 'unknown';
      externalMessageId: string | null;
      errorCode: string | null;
      errorMessage: string | null;
    },
  ): Promise<void> {
    await this.database.query(
      `
      UPDATE notification_channel_deliveries
      SET status = $2,
          delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END,
          external_message_id = $3,
          last_error_code = $4,
          last_error_message = $5,
          locked_at = NULL,
          locked_by = NULL,
          updated_at = now()
      WHERE notification_channel_delivery_id = $1 AND status = 'processing'
      `,
      [
        deliveryId,
        input.status,
        input.externalMessageId,
        input.errorCode,
        input.errorMessage?.slice(0, 500) ?? null,
      ],
    );
  }
}

async function findBinding(client: DatabaseClient, userId: string): Promise<TelegramBinding | null> {
  const result = await client.query<BindingRow>(
    `
    SELECT user_id, destination, display_name, linked_at
    FROM notification_channel_bindings
    WHERE user_id = $1 AND channel = 'telegram'
    `,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId: String(row.user_id),
    destination: row.destination,
    displayName: row.display_name,
    linkedAt: new Date(row.linked_at).toISOString(),
  };
}

async function markUpdateProcessed(tx: DatabaseClient, updateId: string): Promise<void> {
  await tx.query(
    `
    UPDATE telegram_notification_webhook_updates
    SET processed_at = now()
    WHERE update_id = $1
    `,
    [updateId],
  );
}

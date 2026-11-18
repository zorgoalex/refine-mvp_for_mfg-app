import type { DatabaseClient } from '../../../database/database.types';
import type { InsertNotificationInput, NotificationWritePort } from '../ports/notification-write.port';

/**
 * ЕДИНСТВЕННЫЙ писатель строк `notifications` (план 2026-10-03 §2.1): движок правил, сервис закупа, дедлайны и группы
 * пишут только через него (guard-тест `notification-write-single-writer.test.ts`).
 */
/** A balloon slot as stored: trimmed, 1–200 characters; anything else — no slot. */
export function normalizeBalloonSlot(value: string | null | undefined): string | null {
  const slot = typeof value === 'string' ? value.trim() : '';
  return slot.length >= 1 && slot.length <= 200 ? slot : null;
}

export class PgNotificationWriteAdapter implements NotificationWritePort {
  async insertIfAbsent(client: DatabaseClient, input: InsertNotificationInput): Promise<{ created: boolean; notificationId: string }> {
    const balloonMode = input.balloonMode ?? null;
    const slot = balloonMode !== null ? normalizeBalloonSlot(input.balloonSlot) : null;
    const inserted = await client.query<{ notification_id: string; created_at: Date | string }>(
      `INSERT INTO notifications
         (user_id, level, title, message, entity_type, entity_id, source_type, source_id, idempotency_key, balloon_mode, balloon_slot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING notification_id, created_at`,
      [input.userId, input.level, input.title, input.message, input.entityType, input.entityId, input.sourceType, input.sourceId, input.idempotencyKey, balloonMode, slot],
    );
    if (inserted.rows[0]) {
      const notificationId = String(inserted.rows[0].notification_id);
      if (slot !== null) {
        // The fresh balloon replaces every older balloon of the slot: one still to be shown never comes out of the
        // claim (marked shown), one already shown on a screen is named in the next claim answer and that tab closes it
        // (review R1-1); the bell keeps them all.
        await client.query(
          `UPDATE notifications
              SET balloon_shown_at = COALESCE(balloon_shown_at, now()), balloon_superseded_at = now()
            WHERE user_id = $1 AND balloon_slot = $2 AND balloon_superseded_at IS NULL
              AND notification_id <> $3::uuid AND created_at <= $4`,
          [input.userId, slot, notificationId, inserted.rows[0].created_at],
        );
      }
      return { created: true, notificationId };
    }
    const existing = await client.query<{ notification_id: string }>(
      `SELECT notification_id FROM notifications WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    return { created: false, notificationId: String(existing.rows[0].notification_id) };
  }
}

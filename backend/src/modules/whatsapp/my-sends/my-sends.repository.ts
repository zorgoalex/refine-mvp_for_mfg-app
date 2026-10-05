import { Inject, Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DatabaseService } from '../../../database/database.service';
import { estimateQueue, type QueueRow } from '../order-send/order-send-queue';
import { orderFormTitle } from '../order-send/order-send.types';

/** One WhatsApp send the current user started himself (order card or calendar). No recipient ids. */
export interface MySend {
  kind: 'order_send' | 'calendar_send';
  id: string;
  /** Short human title: «Заказ 230725 → клиенту, PDF заказа» / «Календарь, 02.10.2026 → чат». */
  title: string;
  state: string;
  active: boolean;
  /** Approximate start of the delivery while queued/sending (server time, ISO); null when final. */
  estimatedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  cancelReason: string | null;
  orderId: number | null;
  targetDate: string | null;
  /** The caller may cancel it now (an order card send still waiting in the queue). */
  cancellable: boolean;
  /** Cancelled by someone else (a WhatsApp manager), not by the caller. */
  cancelledByOther: boolean;
}

const WINDOW_HOURS = 24;
/** Finished history shown/returned; active sends are always returned in full. */
const LIMIT = 30;
/** Explicitly followed ids (sendId/runId) are looked up within this age, still only the caller's own. */
const FOLLOW_DAYS = 7;
const MAX_IDS = 50;
const ORDER_ACTIVE = new Set(['queued', 'sending']);
const RUN_ACTIVE = new Set(['preparing', 'queued', 'sending']);

/**
 * Read model for the user's own sends: the «отправлено» balloon and the «≈ когда» line under the bell.
 * Strictly scoped to the actor (`actor_id` / `initiated_by_user_id` = the current user).
 */
@Injectable()
export class MySendsRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * Every active send of the caller, the latest finished ones (24 h, up to 30) and — whatever their age
   * within 7 days — the explicitly followed `ids`. All strictly scoped to the caller.
   */
  async list(userId: string, now = new Date(), ids: readonly string[] = []): Promise<MySend[]> {
    const since = new Date(now.getTime() - WINDOW_HOURS * 60 * 60_000);
    const followSince = new Date(now.getTime() - FOLLOW_DAYS * 24 * 60 * 60_000);
    const wanted = [...new Set(ids)].slice(0, MAX_IDS);
    const [orders, calendar] = await Promise.all([
      this.orderSends(userId, since, now, followSince, wanted), this.calendarSends(userId, since, now, followSince, wanted)]);
    const all = [...orders, ...calendar].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const keep = new Set([...all.filter((item) => item.active || wanted.includes(item.id)).map((item) => item.id),
      ...all.filter((item) => !item.active && Date.parse(item.createdAt) >= since.getTime()).slice(0, LIMIT).map((item) => item.id)]);
    return all.filter((item) => keep.has(item.id));
  }

  private async orderSends(userId: string, since: Date, now: Date, followSince: Date, ids: readonly string[]): Promise<MySend[]> {
    const exists = (await this.database.query<{ ok: boolean }>(`SELECT to_regclass('whatsapp_order_sends') IS NOT NULL ok`)).rows[0]?.ok;
    if (!exists) return [];
    const settings = (await this.database.query<{ last_delivery_at: Date | null; min_interval_minutes: number; next_delivery_at: Date | null;
      send_window_minutes: number } & QueryResultRow>(
      'SELECT last_delivery_at, min_interval_minutes, next_delivery_at, send_window_minutes FROM whatsapp_order_send_settings WHERE singleton')).rows[0];
    // The estimate needs the whole queue (everyone's sends ahead of the caller's), never returned itself.
    const queue = (await this.database.query<QueueRow & QueryResultRow>(`SELECT send_id, state, created_at, next_attempt_at, queue_expires_at,
      send_started_at FROM whatsapp_order_sends WHERE state IN ('queued','sending')`)).rows;
    const estimates = settings ? estimateQueue(settings, queue, now) : new Map();
    const rows = (await this.database.query<QueryResultRow & {
      send_id: string; order_id: string | null; order_name: string | null; target_kind: string; chat_label: string | null; form_code: string;
      supplier_request_id: string | null; request_number: string | null; supplier_name: string | null; parts_total: number | null;
      state: string; error_code: string | null; cancel_reason: string | null; next_attempt_at: Date; created_at: Date; sent_at: Date | null; updated_at: Date;
      cancelled_by: string | null;
      employee_name: string | null;
    }>(`SELECT s.send_id, s.order_id, o.order_name, s.target_kind, c.label chat_label, e.full_name employee_name, s.form_code, s.state, s.error_code, s.cancel_reason,
          s.next_attempt_at, s.created_at, s.sent_at, s.updated_at, s.cancelled_by,
          -- A supplier request send: the request and the supplier instead of an order.
          s.supplier_request_id, s.parts_total, sr.request_number, sup.supplier_name
        FROM whatsapp_order_sends s
        JOIN (
          -- Active and followed rows are picked independently of the limited history.
          (SELECT send_id FROM whatsapp_order_sends WHERE actor_id = $1 AND state IN ('queued','sending'))
          UNION (SELECT send_id FROM whatsapp_order_sends WHERE actor_id = $1 AND send_id::text = ANY($4::text[]) AND created_at >= $5)
          UNION (SELECT send_id FROM whatsapp_order_sends WHERE actor_id = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT $3)
        ) picked USING (send_id)
        LEFT JOIN orders o ON o.order_id = s.order_id
        LEFT JOIN whatsapp_order_send_chats c ON c.chat_key = s.chat_key
        LEFT JOIN employees e ON e.employee_id = s.employee_id
        LEFT JOIN supplier_requests sr ON sr.supplier_request_id = s.supplier_request_id
        LEFT JOIN suppliers sup ON sup.supplier_id = s.supplier_id
        ORDER BY s.created_at DESC`, [userId, since, LIMIT, ids, followSince])).rows;
    return rows.map((row) => {
      const active = ORDER_ACTIVE.has(row.state);
      const recipient = row.target_kind === 'client' ? 'клиенту' : row.target_kind === 'chat' ? `в чат «${row.chat_label ?? 'чат'}»`
        : row.employee_name ? `сотруднику «${row.employee_name}»` : 'сотруднику';
      const estimate = estimates.get(row.send_id);
      // A supplier request: «Заявка № 26-0012 → поставщику «…»» and how many messages its text takes.
      const messages = Number(row.parts_total ?? 1);
      const title = row.target_kind === 'supplier'
        ? `Заявка № ${row.request_number ?? row.supplier_request_id ?? ''} → поставщику${row.supplier_name ? ` «${row.supplier_name}»` : ''}${
          messages > 1 ? `, сообщений: ${messages}` : ''}`
        : `Заказ ${row.order_name ?? `#${row.order_id}`} → ${recipient}, ${orderFormTitle(row.form_code)}`;
      return {
        kind: 'order_send', id: row.send_id,
        title,
        state: row.state, active,
        estimatedAt: active ? (estimate?.estimatedAt ?? now).toISOString() : null,
        createdAt: row.created_at.toISOString(),
        finishedAt: active ? null : (row.sent_at ?? row.updated_at).toISOString(),
        errorCode: row.error_code, cancelReason: row.cancel_reason, orderId: row.order_id === null ? null : Number(row.order_id), targetDate: null,
        cancellable: row.state === 'queued',
        cancelledByOther: row.cancel_reason === 'manual' && row.cancelled_by !== null && String(row.cancelled_by) !== String(userId),
      };
    });
  }

  private async calendarSends(userId: string, since: Date, now: Date, followSince: Date, ids: readonly string[]): Promise<MySend[]> {
    const rows = (await this.database.query<QueryResultRow & {
      run_id: string; target_date: string; state: string; reason: string | null; created_at: Date; updated_at: Date;
      calendar_last_delivery_at: Date | null; calendar_min_interval_minutes: number | null;
      next_pending_at: Date | null; started: boolean; last_sent_at: Date | null;
    }>(`SELECT r.run_id, to_char(r.target_date, 'YYYY-MM-DD') target_date, r.state, r.reason, r.created_at, r.updated_at,
          b.calendar_last_delivery_at, b.calendar_min_interval_minutes,
          -- The worker sends strictly in delivery_seq order: the first unsent message blocks the rest.
          (SELECT CASE WHEN m.state = 'pending' THEN m.next_attempt_at END FROM whatsapp_broadcast_messages m
            WHERE m.run_id = r.run_id AND m.state <> 'sent' ORDER BY m.delivery_seq LIMIT 1) next_pending_at,
          EXISTS (SELECT 1 FROM whatsapp_broadcast_messages m WHERE m.run_id = r.run_id AND m.attempt_count > 0) started,
          (SELECT max(m.sent_at) FROM whatsapp_broadcast_messages m WHERE m.run_id = r.run_id) last_sent_at
        FROM whatsapp_broadcast_runs r JOIN whatsapp_broadcasts b ON b.broadcast_id = r.broadcast_id
        JOIN (
          (SELECT run_id FROM whatsapp_broadcast_runs WHERE source = 'calendar' AND initiated_by_user_id = $1 AND state IN ('preparing','queued','sending'))
          UNION (SELECT run_id FROM whatsapp_broadcast_runs WHERE source = 'calendar' AND initiated_by_user_id = $1
            AND run_id::text = ANY($4::text[]) AND created_at >= $5)
          UNION (SELECT run_id FROM whatsapp_broadcast_runs WHERE source = 'calendar' AND initiated_by_user_id = $1 AND created_at >= $2
            ORDER BY created_at DESC LIMIT $3)
        ) picked USING (run_id)
        ORDER BY r.created_at DESC`, [userId, since, LIMIT, ids, followSince])).rows;
    return rows.map((row) => {
      const active = RUN_ACTIVE.has(row.state);
      // A calendar delivery that has not started waits for the calendar frequency threshold.
      const gate = !row.started && row.calendar_last_delivery_at && row.calendar_min_interval_minutes
        ? new Date(row.calendar_last_delivery_at.getTime() + row.calendar_min_interval_minutes * 60_000) : null;
      const [year, month, day] = row.target_date.split('-');
      return {
        kind: 'calendar_send', id: row.run_id, title: `Календарь, ${day}.${month}.${year} → чат`,
        state: row.state, active,
        estimatedAt: active ? latest(now, row.next_pending_at, gate).toISOString() : null,
        createdAt: row.created_at.toISOString(),
        finishedAt: active ? null : (row.last_sent_at ?? row.updated_at).toISOString(),
        errorCode: row.reason, cancelReason: null, orderId: null, targetDate: row.target_date,
        cancellable: false, cancelledByOther: false,
      };
    });
  }
}

function latest(...dates: Array<Date | null>): Date {
  return new Date(Math.max(...dates.filter((date): date is Date => date !== null).map((date) => date.getTime())));
}

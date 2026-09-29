import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { computeDiff } from '../../../common/audit/audit-diff';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { DailyDigestSnapshot } from '../daily-digest-snapshot.types';
import {
  addDays, automaticDeliveryDeadline, businessDate, clockMinutes, fixationWindowState, isoWeekday, minutesToClock, zonedMinute,
} from './broadcast-time';
import {
  BROADCAST_BASE_PERMISSIONS, BROADCAST_MAX_ACTIVE,
  type Broadcast, type BroadcastControl, type BroadcastInput, type BroadcastMessage, type BroadcastRun, type BroadcastRunDetail,
  type BroadcastRunState, type BroadcastSchedule, type BroadcastStoredImage, type BroadcastSummary, type BroadcastUpdateInput,
} from './broadcast.types';

type Client = Pick<DatabaseService, 'query'> | TransactionClient;
type Actor = CurrentUser | null | undefined;

interface BroadcastRow extends QueryResultRow {
  broadcast_id: string | number; name: string; version: number; enabled: boolean; group_chat_id: string | null;
  weekdays: number[]; send_time: string; send_window_minutes: number; catch_up_policy: string; catch_up_deadline: string;
  partial_policy: string; schedule_generation: number; order_date_offset_days: number; cards_per_message: number;
  caption_template: string; required_permissions: string[]; created_at: Date; updated_at: Date;
  updated_by: string | number | null; updated_by_username?: string | null; archived_at: Date | null;
}
interface ScheduleRow extends QueryResultRow {
  broadcast_id: string | number; business_date: string | Date; generation: number; scheduled_at: Date; window_start: string;
  window_end: string; send_window_minutes: number; catch_up_policy: string; catch_up_deadline: string;
  settings_version: number; created_at: Date;
}
interface RunRow extends QueryResultRow {
  run_id: string; broadcast_id: string | number; business_date: string | Date; target_date: string | Date; kind: BroadcastRun['kind'];
  parent_run_id: string | null; state: BroadcastRunState; reason: string | null; order_count: number; total_area: string | number;
  message_count?: number; sent_message_count?: number; destination_chat_id: string; created_at: Date; updated_at: Date;
  image_expires_at: Date | null; scheduled_at: Date | null; superseded_at: Date | null;
}
interface FullRunRow extends RunRow {
  root_run_id: string; auto_origin: boolean; schedule_generation: number | null; settings_version: number;
  snapshot_author_user_id: string | number | null; initiated_by_user_id: string | number | null; required_permissions: string[];
  counter_value: string | number | null; catch_up_policy: string; deadline_at: Date | null; partial_policy: string;
  cards_per_message: number; snapshot: DailyDigestSnapshot | null; renderer_version: string; retry_depth: number;
  content_purged_at: Date | null; request_id: string | null;
}
interface ControlRow extends QueryResultRow {
  paused: boolean; version: number; paused_at: Date | null; paused_by: string | number | null; paused_by_username?: string | null;
}
interface MessageRow extends QueryResultRow {
  delivery_seq: number; message_kind: 'image' | 'text'; image_index: number | null; order_ids: number[]; state: BroadcastMessage['state'];
  attempt_count: number; error_code: string | null; sent_at: Date | null; image_available?: boolean; expires_at: Date;
  file_key: string | null; sha256: string | null; size_bytes: number | null; caption: string | null;
}

export type FixOutcome = 'paused' | 'inactive' | 'not_today' | 'exists' | 'before' | 'fixed' | 'skipped';
export type PrepareOutcome = 'queued' | 'empty' | 'stale' | 'superseded' | 'cancelled' | 'late' | 'revoked';

export interface PreparationContext {
  runId: string; broadcastId: number; businessDate: string; targetDate: string; scheduleGeneration: number;
  settingsVersion: number; cardsPerMessage: 1 | 2; captionTemplate: string; deadlineAt: Date | null; scheduledAt: Date | null;
}

export interface IntentGrant {
  token: string; destinationChatId: string; kind: 'image' | 'text'; fileKey: string | null; sha256: string | null;
  expiresAt: Date; caption: string | null; textBody: string | null;
}

const ACTIVE_RUN_STATES = ['preparing', 'queued', 'sending'];
const TERMINAL_RUN_STATES = ['sent', 'partial', 'failed', 'unknown', 'cancelled', 'expired', 'empty', 'skipped'];

@Injectable()
export class BroadcastRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  // ---------------------------------------------------------------- configuration

  async listBroadcasts(): Promise<BroadcastSummary[]> {
    const rows = await this.database.query<BroadcastRow & { last_state: BroadcastRunState | null; last_created_at: Date | null }>(`
      SELECT b.*, last.state last_state, last.created_at last_created_at
      FROM whatsapp_broadcasts b
      LEFT JOIN LATERAL (SELECT r.state, r.created_at FROM whatsapp_broadcast_runs r
        WHERE r.broadcast_id = b.broadcast_id ORDER BY r.created_at DESC, r.run_id DESC LIMIT 1) last ON true
      WHERE b.archived_at IS NULL ORDER BY lower(b.name), b.broadcast_id`);
    return rows.rows.map((row) => ({
      id: Number(row.broadcast_id), name: row.name, enabled: row.enabled, groupChatId: row.group_chat_id,
      weekdays: row.weekdays.map(Number), sendTime: time5(row.send_time), sendWindowMinutes: Number(row.send_window_minutes),
      orderDateOffsetDays: Number(row.order_date_offset_days), archived: false,
      lastRun: row.last_state && row.last_created_at ? { state: row.last_state, createdAt: row.last_created_at.toISOString() } : null,
    }));
  }

  async getBroadcast(id: number): Promise<Broadcast> {
    const row = (await this.database.query<BroadcastRow>(`${broadcastSelect()} WHERE b.broadcast_id = $1`, [id])).rows[0];
    if (!row) throw notFound();
    return mapBroadcast(row);
  }

  async createBroadcast(input: BroadcastInput, actor: CurrentUser, requestId: string): Promise<Broadcast> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT paused FROM whatsapp_broadcast_control WHERE singleton_id = 1 FOR SHARE');
      if (input.enabled) {
        await lockCapacity(tx);
        await this.assertActiveCapacity(tx, null);
      }
      let id: number;
      try {
        id = Number((await tx.query<{ broadcast_id: string }>(`
          INSERT INTO whatsapp_broadcasts (name, enabled, group_chat_id, weekdays, send_time, send_window_minutes, catch_up_policy,
            catch_up_deadline, partial_policy, order_date_offset_days, cards_per_message, caption_template, required_permissions,
            created_by, updated_by)
          VALUES ($1, $2, $3, $4::smallint[], $5::time, $6, $7, $8::time, $9, $10, $11, $12, $13::text[], $14, $14)
          RETURNING broadcast_id`,
        [input.name, input.enabled, input.groupChatId, input.weekdays, input.sendTime, input.sendWindowMinutes, input.catchUpPolicy,
          input.catchUpDeadline, input.partialPolicy, input.orderDateOffsetDays, input.cardsPerMessage, input.captionTemplate,
          [...BROADCAST_BASE_PERMISSIONS], actor.id])).rows[0].broadcast_id);
      } catch (error) {
        throw mapWriteError(error);
      }
      const row = (await tx.query<BroadcastRow>(`${broadcastSelect()} WHERE b.broadcast_id = $1`, [id])).rows[0];
      await this.audit(tx, actor, requestId, 'created', 'whatsapp_broadcast', id, { after: auditSettings(row) }, { broadcastId: id });
      return mapBroadcast(row);
    });
  }

  async updateBroadcast(id: number, input: BroadcastUpdateInput, actor: CurrentUser, requestId: string): Promise<Broadcast> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT paused FROM whatsapp_broadcast_control WHERE singleton_id = 1 FOR SHARE');
      // Enabling is serialized before the broadcast lock so the 20-broadcast cap holds under concurrency.
      if (input.enabled) await lockCapacity(tx);
      const before = await this.lockBroadcast(tx, id, 'UPDATE');
      if (before.archived_at) throw archived();
      if (before.version !== input.version) throw versionConflict();
      if (input.enabled && !before.enabled) await this.assertActiveCapacity(tx, id);
      try {
        await tx.query(`
          UPDATE whatsapp_broadcasts SET version = version + 1, name = $2, enabled = $3, group_chat_id = $4, weekdays = $5::smallint[],
            send_time = $6::time, send_window_minutes = $7, catch_up_policy = $8, catch_up_deadline = $9::time, partial_policy = $10,
            order_date_offset_days = $11, cards_per_message = $12, caption_template = $13, required_permissions = $14::text[],
            updated_by = $15, updated_at = now()
          WHERE broadcast_id = $1`,
        [id, input.name, input.enabled, input.groupChatId, input.weekdays, input.sendTime, input.sendWindowMinutes, input.catchUpPolicy,
          input.catchUpDeadline, input.partialPolicy, input.orderDateOffsetDays, input.cardsPerMessage, input.captionTemplate,
          [...BROADCAST_BASE_PERMISSIONS], actor.id]);
      } catch (error) {
        throw mapWriteError(error);
      }
      if (!input.enabled) await this.cancelAutomaticWork(tx, id, 'DISABLED');
      const after = (await tx.query<BroadcastRow>(`${broadcastSelect()} WHERE b.broadcast_id = $1`, [id])).rows[0];
      await this.audit(tx, actor, requestId, 'updated', 'whatsapp_broadcast', id,
        { version: after.version, before: auditSettings(before), after: auditSettings(after) }, { broadcastId: id });
      return mapBroadcast(after);
    });
  }

  async archiveBroadcast(id: number, version: number, actor: CurrentUser, requestId: string): Promise<Broadcast> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT paused FROM whatsapp_broadcast_control WHERE singleton_id = 1 FOR SHARE');
      const before = await this.lockBroadcast(tx, id, 'UPDATE');
      if (before.archived_at) throw archived();
      if (before.version !== version) throw versionConflict();
      await tx.query(`UPDATE whatsapp_broadcasts SET version = version + 1, enabled = FALSE, archived_at = now(), archived_by = $2,
        updated_by = $2, updated_at = now() WHERE broadcast_id = $1`, [id, actor.id]);
      await this.cancelAutomaticWork(tx, id, 'ARCHIVED');
      const after = (await tx.query<BroadcastRow>(`${broadcastSelect()} WHERE b.broadcast_id = $1`, [id])).rows[0];
      await this.audit(tx, actor, requestId, 'archived', 'whatsapp_broadcast', id,
        { version: after.version, before: auditSettings(before), after: auditSettings(after) }, { broadcastId: id });
      return mapBroadcast(after);
    });
  }

  async getControl(): Promise<BroadcastControl> {
    const row = (await this.database.query<ControlRow>(`SELECT c.paused, c.version, c.paused_at, c.paused_by, u.username paused_by_username
      FROM whatsapp_broadcast_control c LEFT JOIN users u ON u.user_id = c.paused_by WHERE c.singleton_id = 1`)).rows[0];
    if (!row) throw new ApiError(503, 'BROADCASTS_NOT_MIGRATED', 'Рассылки не настроены');
    return mapControl(row);
  }

  async setControl(version: number, paused: boolean, actor: CurrentUser, requestId: string): Promise<BroadcastControl> {
    return this.database.transaction(async (tx) => {
      const current = (await tx.query<{ paused: boolean; version: number }>(
        'SELECT paused, version FROM whatsapp_broadcast_control WHERE singleton_id = 1 FOR UPDATE')).rows[0];
      if (!current) throw new ApiError(503, 'BROADCASTS_NOT_MIGRATED', 'Рассылки не настроены');
      if (current.version !== version) throw versionConflict();
      const row = { ...(await tx.query<ControlRow>(`
        UPDATE whatsapp_broadcast_control SET paused = $1, version = version + 1, updated_at = now(),
          paused_at = CASE WHEN $1 THEN now() ELSE NULL END, paused_by = CASE WHEN $1 THEN $2::bigint ELSE NULL END
        WHERE singleton_id = 1 RETURNING paused, version, paused_at, paused_by`, [paused, actor.id])).rows[0], paused_by_username: paused ? actor.username : null };
      await this.audit(tx, actor, requestId, paused ? 'control.paused' : 'control.resumed', 'whatsapp_broadcast_control', 1,
        { before: { paused: current.paused }, after: { paused } });
      return mapControl(row);
    });
  }

  async getSchedule(id: number, date: string): Promise<BroadcastSchedule | null> {
    const row = (await this.database.query<ScheduleRow>(`
      SELECT s.* FROM whatsapp_broadcast_schedules s JOIN whatsapp_broadcasts b ON b.broadcast_id = s.broadcast_id
      WHERE s.broadcast_id = $1 AND s.business_date = $2::date AND s.generation = b.schedule_generation`, [id, date])).rows[0];
    return row ? mapSchedule(row) : null;
  }

  // ---------------------------------------------------------------- fixation (plan §6.2)

  async listActiveBroadcastIds(): Promise<number[]> {
    const rows = await this.database.query<{ broadcast_id: string }>(`SELECT broadcast_id FROM whatsapp_broadcasts
      WHERE enabled AND archived_at IS NULL ORDER BY broadcast_id LIMIT ${BROADCAST_MAX_ACTIVE}`);
    return rows.rows.map((row) => Number(row.broadcast_id));
  }

  /**
   * Short transaction: plan the day's dispatch minute once per generation and, when the
   * minute has come, claim the day's automatic slot with a light `preparing` run (or a
   * `skipped` one when the window was missed). No rendering happens here.
   */
  async fixAutomaticRun(id: number, clock: () => Date, drawOffset: (duration: number) => number): Promise<FixOutcome> {
    return this.database.transaction(async (tx) => {
      const control = (await tx.query<{ paused: boolean }>('SELECT paused FROM whatsapp_broadcast_control WHERE singleton_id = 1 FOR SHARE')).rows[0];
      if (!control || control.paused) return 'paused';
      const broadcast = await this.lockBroadcast(tx, id, 'UPDATE');
      if (!broadcast.enabled || broadcast.archived_at || !broadcast.group_chat_id) return 'inactive';
      // Decide with the time read after the locks, not the start of the fixation pass.
      const now = clock();
      const date = businessDate(now);
      if (!broadcast.weekdays.map(Number).includes(isoWeekday(date))) return 'not_today';
      if (await this.hasAutomaticSlot(tx, id, date)) return 'exists';
      const schedule = await this.ensureSchedule(tx, broadcast, date, drawOffset);
      const timing = { scheduledAt: schedule.scheduled_at, catchUpPolicy: schedule.catch_up_policy as Broadcast['catchUpPolicy'], catchUpDeadline: time5(schedule.catch_up_deadline) };
      const state = fixationWindowState(timing, now);
      if (state === 'before') return 'before';
      const runId = randomUUID();
      const skipped = state === 'missed';
      await tx.query(`
        INSERT INTO whatsapp_broadcast_runs (run_id, broadcast_id, business_date, target_date, kind, root_run_id, schedule_generation,
          scheduled_at, settings_version, snapshot_author_user_id, required_permissions, destination_chat_id, catch_up_policy, deadline_at,
          partial_policy, cards_per_message, renderer_version, state, reason, request_id)
        VALUES ($1, $2, $3::date, $4::date, 'auto', $1, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13, $14, 'none', $15, $16, $17)`,
      [runId, id, date, addDays(date, Number(broadcast.order_date_offset_days)), broadcast.schedule_generation, schedule.scheduled_at,
        broadcast.version, broadcast.updated_by, broadcast.required_permissions, broadcast.group_chat_id, schedule.catch_up_policy,
        skipped ? null : automaticDeliveryDeadline(timing, date), broadcast.partial_policy, broadcast.cards_per_message,
        skipped ? 'skipped' : 'preparing', skipped ? 'MISSED_WINDOW' : null, autoCorrelation(runId)]);
      await this.audit(tx, null, autoCorrelation(runId), 'run.auto', 'whatsapp_broadcast_run', runId,
        { businessDate: date, state: skipped ? 'skipped' : 'preparing', scheduleGeneration: broadcast.schedule_generation },
        { broadcastId: id });
      return skipped ? 'skipped' : 'fixed';
    });
  }

  private async hasAutomaticSlot(tx: TransactionClient, id: number, date: string): Promise<boolean> {
    const own = (await tx.query(`SELECT 1 FROM whatsapp_broadcast_runs
      WHERE broadcast_id = $1 AND business_date = $2::date AND kind = 'auto' AND superseded_at IS NULL LIMIT 1`, [id, date])).rows[0];
    if (own) return true;
    if (id !== 1) return false;
    // Legacy guard (plan §6.4): on the cutover day the old digest may already have sent.
    const legacy = (await tx.query(`SELECT 1 FROM whatsapp_daily_digest_runs WHERE kind = 'auto' AND business_date = $1::date LIMIT 1`, [date])).rows[0];
    return Boolean(legacy);
  }

  private async ensureSchedule(tx: TransactionClient, broadcast: BroadcastRow, date: string, drawOffset: (duration: number) => number) {
    const id = Number(broadcast.broadcast_id);
    const existing = (await tx.query<ScheduleRow>(`SELECT * FROM whatsapp_broadcast_schedules
      WHERE broadcast_id = $1 AND business_date = $2::date AND generation = $3`, [id, date, broadcast.schedule_generation])).rows[0];
    if (existing) return existing;
    const duration = Number(broadcast.send_window_minutes);
    const offset = duration > 0 ? drawOffset(duration) : 0;
    if (!Number.isInteger(offset) || offset < 0 || offset >= Math.max(duration, 1)) throw new ApiError(500, 'INTERNAL_ERROR', 'Некорректное время рассылки');
    const start = clockMinutes(time5(broadcast.send_time));
    return (await tx.query<ScheduleRow>(`
      INSERT INTO whatsapp_broadcast_schedules (broadcast_id, business_date, generation, scheduled_at, window_start, window_end,
        send_window_minutes, catch_up_policy, catch_up_deadline, settings_version)
      VALUES ($1, $2::date, $3, $4, $5::time, $6::time, $7, $8, $9::time, $10) RETURNING *`,
    [id, date, broadcast.schedule_generation, zonedMinute(date, start + offset), minutesToClock(start), minutesToClock(start + duration),
      duration, broadcast.catch_up_policy, time5(broadcast.catch_up_deadline), broadcast.version])).rows[0];
  }

  // ---------------------------------------------------------------- preparation

  async listPreparingRuns(limit: number): Promise<string[]> {
    const rows = await this.database.query<{ run_id: string }>(`SELECT run_id FROM whatsapp_broadcast_runs
      WHERE state = 'preparing' AND superseded_at IS NULL AND content_purged_at IS NULL
      ORDER BY scheduled_at NULLS LAST, created_at, run_id LIMIT $1`, [limit]);
    return rows.rows.map((row) => row.run_id);
  }

  async getPreparationContext(runId: string): Promise<PreparationContext | null> {
    const row = (await this.database.query<FullRunRow & { caption_template: string }>(`
      SELECT r.*, b.caption_template FROM whatsapp_broadcast_runs r JOIN whatsapp_broadcasts b USING (broadcast_id)
      WHERE r.run_id = $1 AND r.state = 'preparing' AND r.superseded_at IS NULL AND r.content_purged_at IS NULL`, [runId])).rows[0];
    if (!row) return null;
    return {
      runId, broadcastId: Number(row.broadcast_id), businessDate: isoDate(row.business_date), targetDate: isoDate(row.target_date),
      scheduleGeneration: Number(row.schedule_generation), settingsVersion: Number(row.settings_version),
      cardsPerMessage: Number(row.cards_per_message) as 1 | 2, captionTemplate: row.caption_template,
      deadlineAt: row.deadline_at, scheduledAt: row.scheduled_at,
    };
  }

  /**
   * Finish a `preparing` run under the broadcast lock. Rejects stale work: another
   * generation (replan), changed settings (a fresh run is fixed on the next tick),
   * disabling, a passed deadline or a revoked author.
   */
  async completePreparation(context: PreparationContext, input: {
    snapshot: DailyDigestSnapshot; images: BroadcastStoredImage[]; imageExpiresAt: Date | null; clock?: () => Date;
  }): Promise<PrepareOutcome> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT paused FROM whatsapp_broadcast_control WHERE singleton_id = 1 FOR SHARE');
      const broadcast = await this.lockBroadcast(tx, context.broadcastId, 'UPDATE');
      const run = (await tx.query<FullRunRow>('SELECT * FROM whatsapp_broadcast_runs WHERE run_id = $1 FOR UPDATE', [context.runId])).rows[0];
      // A rollback purge is terminal: purged runs never get content again.
      if (!run || run.state !== 'preparing' || run.superseded_at || run.content_purged_at) return 'stale';
      const now = (input.clock ?? (() => new Date()))();
      if (broadcast.schedule_generation !== Number(run.schedule_generation) || broadcast.version !== Number(run.settings_version)) {
        await tx.query(`UPDATE whatsapp_broadcast_runs SET state = 'cancelled', reason = $2, superseded_at = now(), updated_at = now()
          WHERE run_id = $1`, [context.runId, broadcast.schedule_generation !== Number(run.schedule_generation) ? 'BROADCAST_SCHEDULE_SUPERSEDED' : 'SETTINGS_CHANGED']);
        return 'superseded';
      }
      if (!broadcast.enabled || broadcast.archived_at) {
        await this.markRunIn(tx, context.runId, 'cancelled', 'DISABLED');
        return 'cancelled';
      }
      if (run.deadline_at && run.deadline_at.getTime() <= now.getTime()) {
        await this.markRunIn(tx, context.runId, 'failed', 'BROADCAST_PREPARATION_LATE');
        return 'late';
      }
      if (!(await this.userHasPermissions(tx, run.snapshot_author_user_id, run.required_permissions))) {
        await this.markRunIn(tx, context.runId, 'failed', 'BROADCAST_AUTHOR_PERMISSION_REVOKED');
        await this.audit(tx, null, run.request_id, 'run.permission_revoked', 'whatsapp_broadcast_run', context.runId,
          { authorOk: false, stage: 'preparation', state: 'failed' }, { broadcastId: context.broadcastId });
        return 'revoked';
      }
      const orderIds = input.snapshot.orders.map((order) => order.orderId);
      const empty = input.snapshot.orders.length === 0;
      await tx.query(`UPDATE whatsapp_broadcast_runs SET state = $2, reason = $3, snapshot = $4::jsonb, renderer_version = $5,
        order_count = $6, total_area = $7, image_expires_at = $8, updated_at = now() WHERE run_id = $1`,
      [context.runId, empty ? 'empty' : 'queued', empty ? 'NO_ORDERS' : null, JSON.stringify(input.snapshot), input.snapshot.rendererVersion,
        input.snapshot.orders.length, input.snapshot.totalArea, empty ? null : input.imageExpiresAt]);
      await this.insertImages(tx, context.runId, input.images);
      await this.audit(tx, null, run.request_id, 'run.prepared', 'whatsapp_broadcast_run', context.runId,
        { state: empty ? 'empty' : 'queued', orderCount: orderIds.length, messageCount: input.images.length, targetDate: context.targetDate },
        { broadcastId: context.broadcastId, orderIds });
      return empty ? 'empty' : 'queued';
    });
  }

  async failPreparation(runId: string, reason: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const run = (await tx.query<{ broadcast_id: string }>('SELECT broadcast_id FROM whatsapp_broadcast_runs WHERE run_id = $1', [runId])).rows[0];
      if (!run) return;
      await this.lockBroadcast(tx, Number(run.broadcast_id), 'UPDATE');
      await tx.query(`UPDATE whatsapp_broadcast_runs SET state = 'failed', reason = $2, updated_at = now()
        WHERE run_id = $1 AND state = 'preparing'`, [runId, reason]);
    });
  }

  // ---------------------------------------------------------------- manual / retry / replan (ledger first)

  async runBroadcastId(runId: string): Promise<number> {
    const owner = (await this.database.query<{ broadcast_id: string }>('SELECT broadcast_id FROM whatsapp_broadcast_runs WHERE run_id = $1', [runId])).rows[0];
    if (!owner) throw runNotFound();
    return Number(owner.broadcast_id);
  }

  async findCommand(broadcastId: number, idempotencyKey: string, fingerprint: string): Promise<Record<string, unknown> | null> {
    return findCommandIn(this.database, broadcastId, idempotencyKey, fingerprint);
  }

  async createManualRun(input: {
    broadcastId: number; settingsVersion: number; idempotencyKey: string; fingerprint: string; actor: CurrentUser; requestId: string;
    businessDate: string; targetDate: string; snapshot: DailyDigestSnapshot; images: BroadcastStoredImage[]; imageExpiresAt: Date;
  }, beforeCommit?: () => Promise<void>): Promise<{ runId: string; replayed: boolean }> {
    return this.database.transaction(async (tx) => {
      const control = (await tx.query<{ paused: boolean }>('SELECT paused FROM whatsapp_broadcast_control WHERE singleton_id = 1 FOR SHARE')).rows[0];
      const broadcast = await this.lockBroadcast(tx, input.broadcastId, 'UPDATE');
      const prior = await findCommandIn(tx, input.broadcastId, input.idempotencyKey, input.fingerprint);
      if (prior) return { runId: String(prior.runId), replayed: true };
      if (!control || control.paused) throw paused();
      if (broadcast.archived_at) throw archived();
      if (broadcast.version !== input.settingsVersion) throw versionConflict();
      if (!broadcast.group_chat_id) throw new ApiError(409, 'BROADCAST_DESTINATION_REQUIRED', 'Укажите группу WhatsApp перед отправкой');
      const runId = randomUUID();
      const commandId = randomUUID();
      await this.insertCommand(tx, commandId, input.broadcastId, 'manual', input.idempotencyKey, input.fingerprint, { runId }, input.actor, input.requestId);
      const empty = input.snapshot.orders.length === 0;
      await tx.query(`
        INSERT INTO whatsapp_broadcast_runs (run_id, broadcast_id, business_date, target_date, kind, root_run_id, command_id,
          settings_version, snapshot_author_user_id, initiated_by_user_id, required_permissions, destination_chat_id, catch_up_policy,
          deadline_at, partial_policy, cards_per_message, snapshot, renderer_version, order_count, total_area, state, reason,
          request_id, image_expires_at)
        VALUES ($1, $2, $3::date, $4::date, 'manual', $1, $5, $6, $7, $7, $8::text[], $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17,
          $18, $19, $20, $21)`,
      [runId, input.broadcastId, input.businessDate, input.targetDate, commandId, broadcast.version, input.actor.id,
        broadcast.required_permissions, broadcast.group_chat_id, broadcast.catch_up_policy, empty ? null : input.imageExpiresAt,
        broadcast.partial_policy, broadcast.cards_per_message, JSON.stringify(input.snapshot), input.snapshot.rendererVersion,
        input.snapshot.orders.length, input.snapshot.totalArea, empty ? 'empty' : 'queued', empty ? 'NO_ORDERS' : null,
        input.requestId, empty ? null : input.imageExpiresAt]);
      await this.insertImages(tx, runId, input.images);
      const orderIds = input.snapshot.orders.map((order) => order.orderId);
      await this.audit(tx, input.actor, input.requestId, 'run.manual', 'whatsapp_broadcast_run', runId,
        { businessDate: input.businessDate, targetDate: input.targetDate, orderCount: orderIds.length, messageCount: input.images.length, state: empty ? 'empty' : 'queued' },
        { broadcastId: input.broadcastId, orderIds });
      await beforeCommit?.();
      return { runId, replayed: false };
    });
  }

  async createRetry(parentRunId: string, input: {
    mode: 'remaining' | 'all'; idempotencyKey: string; duplicateRiskConfirmed: boolean; actor: CurrentUser; requestId: string;
    fingerprintFor: (broadcastId: number) => string;
  }): Promise<{ runId: string; replayed: boolean }> {
    const owner = (await this.database.query<{ broadcast_id: string }>('SELECT broadcast_id FROM whatsapp_broadcast_runs WHERE run_id = $1', [parentRunId])).rows[0];
    if (!owner) throw runNotFound();
    const broadcastId = Number(owner.broadcast_id);
    const fingerprint = input.fingerprintFor(broadcastId);
    return this.database.transaction(async (tx) => {
      const control = (await tx.query<{ paused: boolean }>('SELECT paused FROM whatsapp_broadcast_control WHERE singleton_id = 1 FOR SHARE')).rows[0];
      const broadcast = await this.lockBroadcast(tx, broadcastId, 'UPDATE');
      const prior = await findCommandIn(tx, broadcastId, input.idempotencyKey, fingerprint);
      if (prior) return { runId: String(prior.runId), replayed: true };
      if (!control || control.paused) throw paused();
      if (broadcast.archived_at) throw archived();
      const parent = (await tx.query<FullRunRow>('SELECT * FROM whatsapp_broadcast_runs WHERE run_id = $1 FOR UPDATE', [parentRunId])).rows[0];
      if (!parent || Number(parent.broadcast_id) !== broadcastId) throw runNotFound();
      if (await this.chainSuperseded(tx, parent.root_run_id)) throw superseded();
      if (parent.content_purged_at) throw new ApiError(410, 'BROADCAST_CONTENT_PURGED', 'Содержимое запуска удалено; повтор невозможен');
      if (parent.retry_depth >= 3) throw new ApiError(409, 'BROADCAST_RETRY_LIMIT', 'Достигнут предел повторных запусков');
      if (ACTIVE_RUN_STATES.includes(parent.state)) throw new ApiError(409, 'BROADCAST_RETRY_ACTIVE', 'Дождитесь завершения текущего запуска');
      if (parent.image_expires_at && parent.image_expires_at.getTime() <= Date.now()) throw new ApiError(410, 'BROADCAST_IMAGE_EXPIRED', 'Срок хранения изображений истёк');
      if (parent.deadline_at && parent.deadline_at.getTime() <= Date.now()) throw new ApiError(410, 'BROADCAST_DEADLINE_PASSED', 'Срок отправки этого запуска истёк');
      const lineage = await this.chainState(tx, parent.root_run_id);
      // Separate codes: the limit is final, an active retry in the chain is temporary (clients keep their key).
      if (lineage.retryCount >= 3) throw new ApiError(409, 'BROADCAST_RETRY_LIMIT', 'Достигнут предел повторных запусков');
      if (lineage.hasActive) throw new ApiError(409, 'BROADCAST_RETRY_ACTIVE', 'Повторная отправка уже выполняется; дождитесь её завершения');
      const rows = (await tx.query<MessageRow>('SELECT * FROM whatsapp_broadcast_messages WHERE run_id = $1 ORDER BY delivery_seq FOR UPDATE', [parentRunId])).rows;
      if (!rows.length) throw new ApiError(409, 'BROADCAST_RETRY_NOT_AVAILABLE', 'В запуске нет сообщений для повтора');
      const hasUncertain = rows.some((row) => row.state === 'unknown');
      if ((input.mode === 'all' || hasUncertain) && !input.duplicateRiskConfirmed) {
        throw new ApiError(409, 'BROADCAST_DUPLICATE_CONFIRMATION_REQUIRED', 'Повтор может создать дубликаты; подтвердите риск');
      }
      const selected = input.mode === 'all' ? rows
        : rows.filter((row) => row.state === 'pending' || row.state === 'failed' || row.state === 'unknown'
          || (row.state === 'cancelled' && ['DISABLED', 'PAUSED'].includes(row.error_code ?? '')));
      if (!selected.length) throw new ApiError(409, 'BROADCAST_RETRY_NOT_AVAILABLE', 'Нет сообщений для повтора');
      if (selected.some((row) => row.expires_at.getTime() <= Date.now())) throw new ApiError(410, 'BROADCAST_IMAGE_EXPIRED', 'Срок хранения изображения истёк');
      const runId = randomUUID();
      const commandId = randomUUID();
      await this.insertCommand(tx, commandId, broadcastId, 'retry', input.idempotencyKey, fingerprint, { runId }, input.actor, input.requestId);
      await this.insertChildRun(tx, parent, { runId, kind: 'retry', commandId, autoOrigin: false, initiatedBy: input.actor.id, requestId: input.requestId });
      await this.copyMessages(tx, runId, selected);
      const orderIds = selected.flatMap((row) => row.order_ids);
      await this.audit(tx, input.actor, input.requestId, 'run.retry', 'whatsapp_broadcast_run', runId,
        { parentRunId, rootRunId: parent.root_run_id, mode: input.mode, messageCount: selected.length, duplicateRiskConfirmed: input.duplicateRiskConfirmed, state: 'queued' },
        { broadcastId, orderIds });
      return { runId, replayed: false };
    });
  }

  /** «Перепланировать сегодня» (plan §6.3). Returns the new generation. */
  async replanToday(input: {
    broadcastId: number; version: number; idempotencyKey: string; fingerprint: string; actor: CurrentUser; requestId: string; now: Date;
  }): Promise<{ generation: number; replayed: boolean }> {
    return this.database.transaction(async (tx) => {
      const control = (await tx.query<{ paused: boolean }>('SELECT paused FROM whatsapp_broadcast_control WHERE singleton_id = 1 FOR SHARE')).rows[0];
      const broadcast = await this.lockBroadcast(tx, input.broadcastId, 'UPDATE');
      const prior = await findCommandIn(tx, input.broadcastId, input.idempotencyKey, input.fingerprint);
      if (prior) return { generation: Number(prior.generation), replayed: true };
      if (!control || control.paused) throw paused();
      if (broadcast.archived_at) throw archived();
      if (broadcast.version !== input.version) throw versionConflict();
      const date = businessDate(input.now);
      const roots = (await tx.query<{ run_id: string }>(`SELECT run_id FROM whatsapp_broadcast_runs
        WHERE broadcast_id = $1 AND business_date = $2::date AND kind = 'auto' AND superseded_at IS NULL FOR UPDATE`, [input.broadcastId, date])).rows;
      const supersededIds: string[] = [];
      for (const root of roots) {
        const chain = (await tx.query<{ run_id: string }>(`SELECT run_id FROM whatsapp_broadcast_runs WHERE root_run_id = $1 ORDER BY created_at FOR UPDATE`,
          [root.run_id])).rows.map((row) => row.run_id);
        const blocked = (await tx.query<{ blocked: boolean }>(`SELECT EXISTS (SELECT 1 FROM whatsapp_broadcast_messages
          WHERE run_id = ANY($1::uuid[]) AND (state IN ('sending','unknown','sent') OR lock_token IS NOT NULL)) blocked`, [chain])).rows[0]?.blocked;
        if (blocked) throw new ApiError(409, 'BROADCAST_TODAY_ALREADY_SENDING', 'Сегодняшняя рассылка уже отправляется или отправлена; перепланировать нельзя');
        await tx.query(`UPDATE whatsapp_broadcast_messages SET state = 'cancelled', error_code = 'REPLANNED', updated_at = now()
          WHERE run_id = ANY($1::uuid[]) AND state = 'pending'`, [chain]);
        await tx.query(`UPDATE whatsapp_broadcast_runs SET superseded_at = now(), superseded_by_request_id = $2,
          state = CASE WHEN state IN ('preparing','queued','sending') THEN 'cancelled' ELSE state END,
          reason = CASE WHEN state IN ('preparing','queued','sending') THEN 'REPLANNED' ELSE reason END, updated_at = now()
          WHERE run_id = ANY($1::uuid[])`, [chain, input.requestId]);
        supersededIds.push(...chain);
      }
      const generation = broadcast.schedule_generation + 1;
      await tx.query('UPDATE whatsapp_broadcasts SET schedule_generation = $2, updated_at = now() WHERE broadcast_id = $1', [input.broadcastId, generation]);
      await this.insertCommand(tx, randomUUID(), input.broadcastId, 'replan', input.idempotencyKey, input.fingerprint, { generation }, input.actor, input.requestId);
      await this.audit(tx, input.actor, input.requestId, 'schedule_replanned', 'whatsapp_broadcast', input.broadcastId,
        { businessDate: date, generationBefore: broadcast.schedule_generation, generationAfter: generation, supersededRunIds: supersededIds },
        { broadcastId: input.broadcastId });
      return { generation, replayed: false };
    });
  }

  // ---------------------------------------------------------------- delivery

  /** One queued/sending run per broadcast (oldest first) for round-robin delivery. */
  async listDeliverableRuns(): Promise<string[]> {
    const rows = await this.database.query<{ run_id: string }>(`
      SELECT run_id FROM (
        SELECT DISTINCT ON (broadcast_id) run_id, created_at FROM whatsapp_broadcast_runs
        WHERE state IN ('queued','sending') AND content_purged_at IS NULL ORDER BY broadcast_id, created_at, run_id) heads
      ORDER BY created_at, run_id LIMIT ${BROADCAST_MAX_ACTIVE}`);
    return rows.rows.map((row) => row.run_id);
  }

  async messagesForWorker(runId: string) {
    const rows = await this.database.query<{ delivery_seq: number; state: string; next_attempt_at: Date; message_kind: 'image' | 'text' }>(
      'SELECT delivery_seq, state, next_attempt_at, message_kind FROM whatsapp_broadcast_messages WHERE run_id = $1 ORDER BY delivery_seq', [runId]);
    return rows.rows;
  }

  async getImageMetadata(runId: string, seq: number) {
    const row = (await this.database.query<MessageRow & { image_available: boolean }>(`
      SELECT m.*, (m.expires_at > now() AND r.content_purged_at IS NULL) AS image_available
      FROM whatsapp_broadcast_messages m JOIN whatsapp_broadcast_runs r USING (run_id)
      WHERE m.run_id = $1 AND m.delivery_seq = $2 AND m.message_kind = 'image'`, [runId, seq])).rows[0];
    if (!row || !row.file_key || !row.sha256) throw new ApiError(404, 'BROADCAST_MESSAGE_NOT_FOUND', 'Сообщение рассылки не найдено');
    return { fileKey: row.file_key, sha256: row.sha256, expiresAt: row.expires_at, imageAvailable: Boolean(row.image_available) };
  }

  /** Grant one send attempt, re-checking every barrier under the locks (plan §2.1, §4.3, §6.3). */
  async createSendIntent(runId: string, seq: number, runtimeEnabled: boolean, clock: () => Date = () => new Date()): Promise<IntentGrant | null> {
    const owner = (await this.database.query<{ broadcast_id: string }>('SELECT broadcast_id FROM whatsapp_broadcast_runs WHERE run_id = $1', [runId])).rows[0];
    if (!owner) return null;
    const broadcastId = Number(owner.broadcast_id);
    return this.database.transaction(async (tx) => {
      const control = (await tx.query<{ paused: boolean }>('SELECT paused FROM whatsapp_broadcast_control WHERE singleton_id = 1 FOR SHARE')).rows[0];
      if (!control || control.paused) return null;
      const broadcast = await this.lockBroadcast(tx, broadcastId, 'SHARE');
      const run = (await tx.query<FullRunRow>('SELECT * FROM whatsapp_broadcast_runs WHERE run_id = $1 FOR UPDATE', [runId])).rows[0];
      const message = (await tx.query<MessageRow & { next_attempt_at: Date; text_body: string | null }>(
        'SELECT * FROM whatsapp_broadcast_messages WHERE run_id = $1 AND delivery_seq = $2 FOR UPDATE', [runId, seq])).rows[0];
      if (!run || !message || message.state !== 'pending' || !['queued', 'sending'].includes(run.state)) return null;
      if (run.content_purged_at) {
        await this.cancelPendingIn(tx, runId, 'CONTENT_PURGED');
        return null;
      }
      // Current time after the locks: a slow iteration must not send past the deadline.
      const now = clock();
      const earlier = (await tx.query<{ blocked: boolean }>(`SELECT EXISTS (SELECT 1 FROM whatsapp_broadcast_messages
        WHERE run_id = $1 AND delivery_seq < $2 AND state <> 'sent') blocked`, [runId, seq])).rows[0]?.blocked;
      if (earlier) return null;
      if (message.next_attempt_at.getTime() > now.getTime()) return null;
      if (await this.chainSuperseded(tx, run.root_run_id)) {
        await this.cancelPendingIn(tx, runId, 'SUPERSEDED');
        return null;
      }
      if (message.expires_at.getTime() <= now.getTime()) {
        await tx.query(`UPDATE whatsapp_broadcast_messages SET state = 'expired', error_code = 'IMAGE_EXPIRED', updated_at = now()
          WHERE run_id = $1 AND state = 'pending' AND expires_at <= $2`, [runId, now]);
        await this.reconcileTerminalRun(tx, runId, 'IMAGE_EXPIRED');
        return null;
      }
      if (run.deadline_at && run.deadline_at.getTime() < now.getTime()) {
        await tx.query(`UPDATE whatsapp_broadcast_messages SET state = 'expired', error_code = 'DEADLINE', updated_at = now()
          WHERE run_id = $1 AND state = 'pending'`, [runId]);
        await this.reconcileTerminalRun(tx, runId, 'DEADLINE');
        return null;
      }
      const automatic = run.kind === 'auto' || run.auto_origin;
      if (automatic && (!runtimeEnabled || !broadcast.enabled || broadcast.archived_at)) return null;
      const authorOk = await this.userHasPermissions(tx, run.snapshot_author_user_id, run.required_permissions);
      const initiatorOk = run.initiated_by_user_id === null || await this.userHasPermissions(tx, run.initiated_by_user_id, run.required_permissions);
      if (!authorOk || !initiatorOk) {
        await tx.query(`UPDATE whatsapp_broadcast_messages SET state = 'cancelled', error_code = 'PERMISSION_REVOKED', updated_at = now()
          WHERE run_id = $1 AND state = 'pending'`, [runId]);
        const revokedState = (await tx.query<{ state: BroadcastRunState }>(`UPDATE whatsapp_broadcast_runs SET state = CASE WHEN EXISTS (SELECT 1 FROM whatsapp_broadcast_messages m
            WHERE m.run_id = $1 AND m.state = 'sent') THEN 'partial' ELSE 'failed' END, reason = 'BROADCAST_AUTHOR_PERMISSION_REVOKED',
          updated_at = now() WHERE run_id = $1 RETURNING state`, [runId])).rows[0]?.state ?? 'failed';
        await this.audit(tx, null, run.request_id, 'run.permission_revoked', 'whatsapp_broadcast_run', runId,
          { authorOk, initiatorOk, stage: 'send_intent', state: revokedState }, { broadcastId });
        return null;
      }
      const token = randomUUID();
      await tx.query(`UPDATE whatsapp_broadcast_messages SET state = 'sending', attempt_count = attempt_count + 1, send_started_at = now(),
        lock_token = $3, updated_at = now() WHERE run_id = $1 AND delivery_seq = $2`, [runId, seq, token]);
      await tx.query(`UPDATE whatsapp_broadcast_runs SET state = 'sending', updated_at = now() WHERE run_id = $1`, [runId]);
      await this.audit(tx, null, run.request_id, 'message.intent', 'whatsapp_broadcast_run', runId,
        { deliverySeq: seq, kind: message.message_kind, runKind: run.kind, state: 'sending' }, { broadcastId, orderIds: message.order_ids });
      return {
        token, destinationChatId: run.destination_chat_id, kind: message.message_kind, fileKey: message.file_key, sha256: message.sha256,
        expiresAt: message.expires_at, caption: message.caption, textBody: message.text_body,
      };
    });
  }

  async settleMessage(runId: string, seq: number, token: string, result: { state: 'sent' | 'unknown' | 'failed'; providerMessageId?: string; errorCode?: string }) {
    const owner = (await this.database.query<{ broadcast_id: string; request_id: string | null }>('SELECT broadcast_id, request_id FROM whatsapp_broadcast_runs WHERE run_id = $1', [runId])).rows[0];
    if (!owner) return false;
    return this.database.transaction(async (tx) => {
      await this.lockBroadcast(tx, Number(owner.broadcast_id), 'SHARE');
      await tx.query('SELECT 1 FROM whatsapp_broadcast_runs WHERE run_id = $1 FOR UPDATE', [runId]);
      const message = (await tx.query<{ state: string; lock_token: string | null; order_ids: number[] }>(
        'SELECT state, lock_token, order_ids FROM whatsapp_broadcast_messages WHERE run_id = $1 AND delivery_seq = $2 FOR UPDATE', [runId, seq])).rows[0];
      if (!message || message.state !== 'sending' || message.lock_token !== token) return false;
      await tx.query(`UPDATE whatsapp_broadcast_messages SET state = $4, provider_message_id = $5, error_code = $6,
        sent_at = CASE WHEN $4 = 'sent' THEN now() ELSE NULL END, lock_token = NULL, updated_at = now()
        WHERE run_id = $1 AND delivery_seq = $2 AND lock_token = $3`,
      [runId, seq, token, result.state, result.providerMessageId ?? null, result.errorCode ?? null]);
      await this.refreshRunState(tx, runId, result.state === 'failed' ? result.errorCode ?? null : null);
      await this.audit(tx, null, owner.request_id, `message.${result.state}`, 'whatsapp_broadcast_run', runId,
        { deliverySeq: seq, errorCode: result.errorCode ?? null, state: result.state }, { broadcastId: Number(owner.broadcast_id), orderIds: message.order_ids });
      return true;
    });
  }

  async failPendingBeforeIntent(runId: string, seq: number, errorCode: string) {
    const owner = (await this.database.query<{ broadcast_id: string; request_id: string | null }>('SELECT broadcast_id, request_id FROM whatsapp_broadcast_runs WHERE run_id = $1', [runId])).rows[0];
    if (!owner) return;
    await this.database.transaction(async (tx) => {
      await this.lockBroadcast(tx, Number(owner.broadcast_id), 'SHARE');
      await tx.query('SELECT 1 FROM whatsapp_broadcast_runs WHERE run_id = $1 FOR UPDATE', [runId]);
      const message = (await tx.query<{ state: string; preflight_attempt_count: number; order_ids: number[] }>(
        'SELECT state, preflight_attempt_count, order_ids FROM whatsapp_broadcast_messages WHERE run_id = $1 AND delivery_seq = $2 FOR UPDATE', [runId, seq])).rows[0];
      if (!message || message.state !== 'pending') return;
      const attempts = message.preflight_attempt_count + 1;
      if (attempts < 3) {
        await tx.query(`UPDATE whatsapp_broadcast_messages SET preflight_attempt_count = $3, next_attempt_at = now() + interval '1 minute',
          error_code = $4, updated_at = now() WHERE run_id = $1 AND delivery_seq = $2`, [runId, seq, attempts, errorCode]);
      } else {
        await tx.query(`UPDATE whatsapp_broadcast_messages SET preflight_attempt_count = $3, state = 'failed', error_code = $4, updated_at = now()
          WHERE run_id = $1 AND delivery_seq = $2`, [runId, seq, attempts, errorCode]);
        await tx.query(`UPDATE whatsapp_broadcast_runs r SET state = CASE WHEN EXISTS (SELECT 1 FROM whatsapp_broadcast_messages m
            WHERE m.run_id = r.run_id AND m.state = 'sent') THEN 'partial' ELSE 'failed' END, reason = $2, updated_at = now()
          WHERE r.run_id = $1 AND r.state IN ('queued','sending')`, [runId, errorCode]);
      }
      await this.audit(tx, null, owner.request_id, 'message.preflight_failed', 'whatsapp_broadcast_run', runId,
        { deliverySeq: seq, errorCode, attemptCount: attempts }, { broadcastId: Number(owner.broadcast_id), orderIds: message.order_ids });
    });
  }

  async markStaleIntentsUnknown(staleAfterMs: number, now = new Date()) {
    const stale = (await this.database.query<{ run_id: string; delivery_seq: number; broadcast_id: string; request_id: string | null }>(`
      SELECT m.run_id, m.delivery_seq, r.broadcast_id, r.request_id FROM whatsapp_broadcast_messages m JOIN whatsapp_broadcast_runs r USING (run_id)
      WHERE m.state = 'sending' AND m.send_started_at < $1 LIMIT 100`, [new Date(now.getTime() - staleAfterMs)])).rows;
    for (const item of stale) {
      await this.database.transaction(async (tx) => {
        await this.lockBroadcast(tx, Number(item.broadcast_id), 'SHARE');
        await tx.query('SELECT 1 FROM whatsapp_broadcast_runs WHERE run_id = $1 FOR UPDATE', [item.run_id]);
        const updated = await tx.query(`UPDATE whatsapp_broadcast_messages SET state = 'unknown', error_code = 'PROCESS_LOST_AFTER_INTENT',
          lock_token = NULL, updated_at = now() WHERE run_id = $1 AND delivery_seq = $2 AND state = 'sending' AND send_started_at < $3`,
        [item.run_id, item.delivery_seq, new Date(now.getTime() - staleAfterMs)]);
        if (!updated.rowCount) return;
        await tx.query(`UPDATE whatsapp_broadcast_runs SET state = 'unknown', reason = 'PROVIDER_OUTCOME_UNKNOWN', updated_at = now()
          WHERE run_id = $1 AND state = 'sending'`, [item.run_id]);
        await this.audit(tx, null, item.request_id, 'message.intent_stale', 'whatsapp_broadcast_run', item.run_id,
          { deliverySeq: item.delivery_seq, state: 'unknown' }, { broadcastId: Number(item.broadcast_id) });
      });
    }
  }

  async markRun(runId: string, state: BroadcastRunState, reason: string | null) {
    await this.database.query('UPDATE whatsapp_broadcast_runs SET state = $2, reason = $3, updated_at = now() WHERE run_id = $1', [runId, state, reason]);
  }

  /** One bounded automatic child after an exhausted preflight failure (unknown messages are never eligible). */
  async createPolicyRetryAfterPreflightFailure(parentRunId: string): Promise<string | null> {
    const owner = (await this.database.query<{ broadcast_id: string }>('SELECT broadcast_id FROM whatsapp_broadcast_runs WHERE run_id = $1', [parentRunId])).rows[0];
    if (!owner) return null;
    const broadcastId = Number(owner.broadcast_id);
    return this.database.transaction(async (tx) => {
      const control = (await tx.query<{ paused: boolean }>('SELECT paused FROM whatsapp_broadcast_control WHERE singleton_id = 1 FOR SHARE')).rows[0];
      if (!control || control.paused) return null;
      const broadcast = await this.lockBroadcast(tx, broadcastId, 'UPDATE');
      if (!broadcast.enabled || broadcast.archived_at) return null;
      const parent = (await tx.query<FullRunRow>('SELECT * FROM whatsapp_broadcast_runs WHERE run_id = $1 FOR UPDATE', [parentRunId])).rows[0];
      if (!parent || parent.partial_policy === 'manual' || (!parent.auto_origin && parent.kind !== 'auto')) return null;
      if (!['failed', 'partial'].includes(parent.state)) return null;
      if (!['IMAGE_UNAVAILABLE', 'BROADCAST_STORE_BUSY', 'WHATSAPP_DAILY_DIGEST_STORE_BUSY', 'WHATSAPP_DAILY_DIGEST_STORE_UNAVAILABLE',
        'WHATSAPP_DAILY_DIGEST_IMAGE_MISSING', 'WHATSAPP_DAILY_DIGEST_IMAGE_INVALID'].includes(parent.reason ?? '')) return null;
      if ((parent.image_expires_at && parent.image_expires_at.getTime() <= Date.now()) || (parent.deadline_at && parent.deadline_at.getTime() <= Date.now())) return null;
      if (await this.chainSuperseded(tx, parent.root_run_id)) return null;
      const lineage = await this.chainState(tx, parent.root_run_id);
      if (lineage.retryCount >= 3 || lineage.hasActive) return null;
      const messages = (await tx.query<MessageRow>('SELECT * FROM whatsapp_broadcast_messages WHERE run_id = $1 ORDER BY delivery_seq FOR UPDATE', [parentRunId])).rows;
      if (!messages.length || messages.some((row) => row.state === 'unknown' || row.state === 'sending')) return null;
      const selected = parent.partial_policy === 'repeat_all' ? messages : messages.filter((row) => row.state === 'pending' || row.state === 'failed');
      if (!selected.length || selected.some((row) => row.expires_at.getTime() <= Date.now())) return null;
      const runId = randomUUID();
      await this.insertChildRun(tx, parent, { runId, kind: 'retry', commandId: null, autoOrigin: true, initiatedBy: null, requestId: parent.request_id });
      await this.copyMessages(tx, runId, selected);
      await tx.query(`UPDATE whatsapp_broadcast_messages SET state = 'cancelled', error_code = 'SUPERSEDED_BY_POLICY_RETRY', updated_at = now()
        WHERE run_id = $1 AND state = 'pending'`, [parentRunId]);
      await this.audit(tx, null, parent.request_id, 'run.policy_retry', 'whatsapp_broadcast_run', runId,
        { parentRunId, rootRunId: parent.root_run_id, policy: parent.partial_policy, messageCount: selected.length, state: 'queued' },
        { broadcastId, orderIds: selected.flatMap((row) => row.order_ids) });
      return runId;
    });
  }

  // ---------------------------------------------------------------- reads

  async listRuns(broadcastId: number): Promise<BroadcastRun[]> {
    const rows = await this.database.query<RunRow>(`${runSelect()} WHERE r.broadcast_id = $1 ORDER BY r.created_at DESC, r.run_id DESC LIMIT 50`, [broadcastId]);
    return rows.rows.map(mapRun);
  }

  async getRunDetail(runId: string): Promise<BroadcastRunDetail> {
    const run = (await this.database.query<RunRow>(`${runSelect()} WHERE r.run_id = $1`, [runId])).rows[0];
    if (!run) throw runNotFound();
    const messages = await this.database.query<MessageRow>(`
      SELECT m.*, (m.message_kind = 'image' AND m.expires_at > now() AND r.content_purged_at IS NULL) AS image_available
      FROM whatsapp_broadcast_messages m JOIN whatsapp_broadcast_runs r USING (run_id) WHERE m.run_id = $1 ORDER BY m.delivery_seq`, [runId]);
    return { run: mapRun(run), messages: messages.rows.map(mapMessage) };
  }

  // ---------------------------------------------------------------- retention (plan §3 TTL, §2.2)

  async expireAndPrune(now = new Date()) {
    const expiring = (await this.database.query<{ run_id: string; broadcast_id: string }>(`
      SELECT DISTINCT r.run_id, r.broadcast_id FROM whatsapp_broadcast_runs r JOIN whatsapp_broadcast_messages m USING (run_id)
      WHERE m.expires_at <= $1 AND m.state IN ('pending','failed') LIMIT 200`, [now])).rows;
    for (const item of expiring) {
      await this.database.transaction(async (tx) => {
        await this.lockBroadcast(tx, Number(item.broadcast_id), 'SHARE');
        await tx.query('SELECT 1 FROM whatsapp_broadcast_runs WHERE run_id = $1 FOR UPDATE', [item.run_id]);
        await tx.query(`UPDATE whatsapp_broadcast_messages SET state = 'expired', error_code = 'IMAGE_EXPIRED', updated_at = now()
          WHERE run_id = $1 AND expires_at <= $2 AND state IN ('pending','failed')`, [item.run_id, now]);
        await this.reconcileTerminalRun(tx, item.run_id, 'IMAGE_EXPIRED');
      });
    }
    return this.database.transaction(async (tx) => {
      await tx.query(`UPDATE whatsapp_broadcast_runs SET snapshot = NULL, snapshot_purged_at = now()
        WHERE created_at <= $1::timestamptz - interval '30 days' AND snapshot IS NOT NULL AND state <> ALL($2::text[])`, [now, ACTIVE_RUN_STATES]);
      const prune = (await tx.query<{ run_id: string }>(`SELECT r.run_id FROM whatsapp_broadcast_runs r
        WHERE r.updated_at <= $1::timestamptz - interval '90 days' AND r.state = ANY($2::text[])
          AND NOT EXISTS (SELECT 1 FROM whatsapp_broadcast_runs child WHERE child.parent_run_id = r.run_id)
          AND NOT EXISTS (SELECT 1 FROM whatsapp_broadcast_runs member WHERE member.root_run_id = r.run_id AND member.run_id <> r.run_id)
          AND NOT EXISTS (SELECT 1 FROM whatsapp_broadcast_messages m WHERE m.run_id = r.run_id AND m.state = 'sending')
        ORDER BY r.updated_at, r.run_id FOR UPDATE SKIP LOCKED LIMIT 100`, [now, TERMINAL_RUN_STATES])).rows.map((row) => row.run_id);
      if (prune.length) {
        await tx.query('DELETE FROM whatsapp_broadcast_messages WHERE run_id = ANY($1::uuid[])', [prune]);
        await tx.query('DELETE FROM whatsapp_broadcast_runs WHERE run_id = ANY($1::uuid[])', [prune]);
      }
      await tx.query(`DELETE FROM whatsapp_broadcast_commands c WHERE c.created_at <= $1::timestamptz - interval '90 days'
        AND NOT EXISTS (SELECT 1 FROM whatsapp_broadcast_runs r WHERE r.command_id = c.command_id)`, [now]);
      await tx.query(`DELETE FROM whatsapp_broadcast_schedules WHERE business_date < (($1::timestamptz AT TIME ZONE 'Asia/Almaty')::date - 90)`, [now]);
      const [refs, expired] = await Promise.all([
        // Every unexpired image stays referenced: cancelled (disabled/paused) messages may still be retried or viewed.
        tx.query<{ file_key: string; expires_at: Date }>(`SELECT file_key, expires_at FROM whatsapp_broadcast_messages
          WHERE file_key IS NOT NULL AND expires_at > $1`, [now]),
        tx.query<{ file_key: string }>('SELECT file_key FROM whatsapp_broadcast_messages WHERE file_key IS NOT NULL AND expires_at <= $1', [now]),
      ]);
      return {
        referenced: new Map(refs.rows.map((row) => [row.file_key, row.expires_at])),
        expiredKeys: expired.rows.map((row) => row.file_key),
        prunedRuns: prune.length,
      };
    });
  }

  async legacyQueueUnfinished(): Promise<boolean> {
    const row = (await this.database.query<{ unfinished: boolean }>(`SELECT
      EXISTS (SELECT 1 FROM whatsapp_daily_digest_runs WHERE state IN ('queued','sending'))
      OR EXISTS (SELECT 1 FROM whatsapp_daily_digest_pages WHERE state IN ('pending','sending')) AS unfinished`)).rows[0];
    return Boolean(row?.unfinished);
  }

  // ---------------------------------------------------------------- internals

  private async lockBroadcast(tx: TransactionClient, id: number, mode: 'UPDATE' | 'SHARE'): Promise<BroadcastRow> {
    const row = (await tx.query<BroadcastRow>(`SELECT * FROM whatsapp_broadcasts WHERE broadcast_id = $1 FOR ${mode}`, [id])).rows[0];
    if (!row) throw notFound();
    return row;
  }

  private async assertActiveCapacity(tx: TransactionClient, exceptId: number | null) {
    const count = Number((await tx.query<{ count: string }>(`SELECT count(*) FROM whatsapp_broadcasts
      WHERE enabled AND archived_at IS NULL AND ($1::bigint IS NULL OR broadcast_id <> $1)`, [exceptId])).rows[0]?.count ?? 0);
    if (count >= BROADCAST_MAX_ACTIVE) throw new ApiError(409, 'BROADCAST_ACTIVE_LIMIT', `Одновременно могут работать не больше ${BROADCAST_MAX_ACTIVE} рассылок`);
  }

  /** Disable/archive: cancel only this broadcast's automatic work (plan §6.1). */
  private async cancelAutomaticWork(tx: TransactionClient, id: number, reason: 'DISABLED' | 'ARCHIVED') {
    const runs = (await tx.query<{ run_id: string }>(`SELECT run_id FROM whatsapp_broadcast_runs
      WHERE broadcast_id = $1 AND (kind = 'auto' OR auto_origin) AND state IN ('preparing','queued','sending') ORDER BY created_at FOR UPDATE`, [id])).rows;
    for (const run of runs) {
      await tx.query(`UPDATE whatsapp_broadcast_runs SET state = 'cancelled', reason = $2, updated_at = now()
        WHERE run_id = $1 AND state = 'preparing'`, [run.run_id, reason]);
      await this.cancelPendingIn(tx, run.run_id, reason === 'ARCHIVED' ? 'DISABLED' : reason);
    }
  }

  private async cancelPendingIn(tx: TransactionClient, runId: string, errorCode: string) {
    await tx.query(`UPDATE whatsapp_broadcast_messages SET state = 'cancelled', error_code = $2, updated_at = now()
      WHERE run_id = $1 AND state = 'pending'`, [runId, errorCode]);
    await this.reconcileTerminalRun(tx, runId, errorCode);
  }

  private async chainSuperseded(tx: TransactionClient, rootRunId: string): Promise<boolean> {
    const row = (await tx.query<{ superseded_at: Date | null }>('SELECT superseded_at FROM whatsapp_broadcast_runs WHERE run_id = $1', [rootRunId])).rows[0];
    return Boolean(row?.superseded_at);
  }

  private async chainState(tx: TransactionClient, rootRunId: string): Promise<{ retryCount: number; hasActive: boolean }> {
    const row = (await tx.query<{ retry_count: number; has_active: boolean }>(`SELECT count(*) FILTER (WHERE kind = 'retry')::int retry_count,
      COALESCE(bool_or(state IN ('preparing','queued','sending')), false) has_active FROM whatsapp_broadcast_runs WHERE root_run_id = $1`, [rootRunId])).rows[0];
    return { retryCount: Number(row?.retry_count ?? 0), hasActive: Boolean(row?.has_active) };
  }

  private async userHasPermissions(tx: TransactionClient, userId: string | number | null, permissions: string[]): Promise<boolean> {
    if (userId === null || userId === undefined) return false;
    const row = (await tx.query<{ allowed: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM users u JOIN roles ro ON ro.role_id = u.role_id
        WHERE u.user_id = $1 AND u.is_active AND ro.is_active
          AND NOT EXISTS (SELECT 1 FROM unnest($2::text[]) need(permission_name)
            WHERE NOT EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions_catalog pc ON pc.permission_name = rp.permission_name
              WHERE rp.role_id = u.role_id AND rp.permission_name = need.permission_name AND rp.is_enabled AND pc.is_active))
      ) AS allowed`, [userId, permissions])).rows[0];
    return Boolean(row?.allowed);
  }

  private async insertCommand(tx: TransactionClient, commandId: string, broadcastId: number, kind: 'manual' | 'retry' | 'replan',
    key: string, fingerprint: string, result: Record<string, unknown>, actor: CurrentUser, requestId: string) {
    await tx.query(`INSERT INTO whatsapp_broadcast_commands (command_id, broadcast_id, kind, idempotency_key, fingerprint, result, created_by, request_id)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`, [commandId, broadcastId, kind, key, fingerprint, JSON.stringify(result), actor.id, requestId]);
  }

  private async insertChildRun(tx: TransactionClient, parent: FullRunRow, input: {
    runId: string; kind: 'retry'; commandId: string | null; autoOrigin: boolean; initiatedBy: string | null; requestId: string | null;
  }) {
    await tx.query(`
      INSERT INTO whatsapp_broadcast_runs (run_id, broadcast_id, business_date, target_date, kind, auto_origin, parent_run_id, root_run_id,
        command_id, settings_version, snapshot_author_user_id, initiated_by_user_id, required_permissions, counter_value, destination_chat_id,
        catch_up_policy, deadline_at, partial_policy, cards_per_message, snapshot, renderer_version, order_count, total_area, state,
        retry_depth, request_id, image_expires_at)
      VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13::text[], $14, $15, $16, $17, $18, $19, $20::jsonb, $21,
        $22, $23, 'queued', $24, $25, $26)`,
    [input.runId, parent.broadcast_id, parent.business_date, parent.target_date, input.kind, input.autoOrigin,
      parent.run_id, parent.root_run_id, input.commandId, parent.settings_version, parent.snapshot_author_user_id, input.initiatedBy,
      parent.required_permissions, parent.counter_value, parent.destination_chat_id, parent.catch_up_policy, parent.deadline_at,
      parent.partial_policy, parent.cards_per_message, parent.snapshot ? JSON.stringify(parent.snapshot) : null, parent.renderer_version,
      parent.order_count, parent.total_area, parent.retry_depth + 1, input.requestId, parent.image_expires_at]);
  }

  private async copyMessages(tx: TransactionClient, runId: string, rows: MessageRow[]) {
    for (const row of rows) {
      await tx.query(`INSERT INTO whatsapp_broadcast_messages (run_id, delivery_seq, message_kind, image_index, order_ids, file_key, sha256,
        size_bytes, caption, expires_at, state) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, 'pending')`,
      [runId, row.delivery_seq, row.message_kind, row.image_index, JSON.stringify(row.order_ids), row.file_key, row.sha256, row.size_bytes,
        row.caption, row.expires_at]);
    }
  }

  private async insertImages(tx: TransactionClient, runId: string, images: BroadcastStoredImage[]) {
    for (const image of images) {
      await tx.query(`INSERT INTO whatsapp_broadcast_messages (run_id, delivery_seq, message_kind, image_index, order_ids, file_key, sha256,
        size_bytes, caption, expires_at, state) VALUES ($1, $2, 'image', $2, $3::jsonb, $4, $5, $6, $7, $8, 'pending')`,
      [runId, image.imageIndex, JSON.stringify(image.orderIds), image.fileKey, image.sha256, image.sizeBytes, image.caption, image.expiresAt]);
    }
  }

  private async markRunIn(tx: TransactionClient, runId: string, state: BroadcastRunState, reason: string) {
    await tx.query('UPDATE whatsapp_broadcast_runs SET state = $2, reason = $3, updated_at = now() WHERE run_id = $1', [runId, state, reason]);
  }

  private async refreshRunState(tx: TransactionClient, runId: string, failureCode: string | null) {
    const all = (await tx.query<{ pending: number; sent: number; unknown: number; failed: number; cancelled: number; expired: number }>(`SELECT
      count(*) FILTER (WHERE state IN ('pending','sending'))::int pending, count(*) FILTER (WHERE state = 'sent')::int sent,
      count(*) FILTER (WHERE state = 'unknown')::int unknown, count(*) FILTER (WHERE state = 'failed')::int failed,
      count(*) FILTER (WHERE state = 'cancelled')::int cancelled, count(*) FILTER (WHERE state = 'expired')::int expired
      FROM whatsapp_broadcast_messages WHERE run_id = $1`, [runId])).rows[0];
    const state: BroadcastRunState = all.unknown ? 'unknown'
      : all.pending ? (failureCode ? (all.sent ? 'partial' : 'failed') : 'sending')
        : all.cancelled ? (all.sent ? 'partial' : 'cancelled')
          : all.expired ? (all.sent ? 'partial' : 'expired')
            : all.failed ? (all.sent ? 'partial' : 'failed') : 'sent';
    const reason = state === 'unknown' ? 'PROVIDER_OUTCOME_UNKNOWN'
      : state === 'cancelled' ? 'DISABLED' : state === 'expired' ? 'IMAGE_EXPIRED'
        : state === 'partial' ? (all.cancelled ? 'DISABLED_PARTIAL' : all.expired ? 'IMAGE_EXPIRED_PARTIAL' : failureCode)
          : failureCode;
    await tx.query('UPDATE whatsapp_broadcast_runs SET state = $2, reason = $3, updated_at = now() WHERE run_id = $1', [runId, state, reason]);
  }

  private async reconcileTerminalRun(tx: TransactionClient, runId: string, reason: string) {
    await tx.query(`UPDATE whatsapp_broadcast_runs r SET
      state = CASE WHEN EXISTS (SELECT 1 FROM whatsapp_broadcast_messages m WHERE m.run_id = r.run_id AND m.state = 'unknown') THEN 'unknown'
                   WHEN EXISTS (SELECT 1 FROM whatsapp_broadcast_messages m WHERE m.run_id = r.run_id AND m.state = 'sent') THEN 'partial'
                   WHEN EXISTS (SELECT 1 FROM whatsapp_broadcast_messages m WHERE m.run_id = r.run_id AND m.state = 'cancelled') THEN 'cancelled'
                   WHEN EXISTS (SELECT 1 FROM whatsapp_broadcast_messages m WHERE m.run_id = r.run_id AND m.state = 'failed') THEN 'failed' ELSE 'expired' END,
      reason = CASE WHEN EXISTS (SELECT 1 FROM whatsapp_broadcast_messages m WHERE m.run_id = r.run_id AND m.state = 'unknown') THEN 'PROVIDER_OUTCOME_UNKNOWN'
                    WHEN EXISTS (SELECT 1 FROM whatsapp_broadcast_messages m WHERE m.run_id = r.run_id AND m.state = 'sent') THEN left($2 || '_PARTIAL', 64)
                    ELSE $2 END,
      updated_at = now()
      WHERE r.run_id = $1 AND r.state IN ('queued','sending')
        AND NOT EXISTS (SELECT 1 FROM whatsapp_broadcast_messages m WHERE m.run_id = r.run_id AND m.state IN ('pending','sending'))`, [runId, reason]);
  }

  /**
   * `before`/`after` (settings, pause) go to the audit_log before/after/diff columns and
   * `state` (run or message state after the event) to status_field/status_code; the rest
   * stays in metadata.
   */
  private async audit(tx: TransactionClient, actor: Actor, requestId: string | null | undefined, action: string, entityType: string,
    entityId: string | number, details: Record<string, unknown>, related: { broadcastId?: number; orderIds?: number[] } = {}) {
    const { before, after, state, ...metadata } = details as {
      before?: Record<string, unknown>; after?: Record<string, unknown>; state?: string; [key: string]: unknown;
    };
    await auditService.record(tx, {
      event: `whatsapp.broadcast.${action}`, entityType, entityId,
      actorUserId: actor?.id ?? null, actorUsername: actor?.username ?? null, actorRole: actor?.role ?? null,
      requestId: requestId ?? 'whatsapp-broadcast-system', source: 'erp_whatsapp_broadcast',
      before: before ?? null, after: after ?? null, diff: before || after ? computeDiff(before, after) : null,
      statusField: state ? (action.startsWith('message.') ? 'message_state' : 'run_state') : null, statusCode: state ?? null,
      metadata: Object.keys(metadata).length ? metadata : null,
      relatedEntities: [
        ...(related.broadcastId ? [{ entityType: 'whatsapp_broadcast', entityId: related.broadcastId }] : []),
        ...(related.orderIds ?? []).map((orderId) => ({ entityType: 'order', entityId: orderId })),
      ],
    });
  }
}

async function findCommandIn(client: Client, broadcastId: number, key: string, fingerprint: string): Promise<Record<string, unknown> | null> {
  const row = (await client.query<{ fingerprint: string; result: Record<string, unknown> }>(
    'SELECT fingerprint, result FROM whatsapp_broadcast_commands WHERE broadcast_id = $1 AND idempotency_key = $2', [broadcastId, key])).rows[0];
  if (!row) return null;
  if (row.fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Этот ключ уже использован для другой команды');
  return row.result;
}

/** Serializes enabling broadcasts (the 20-broadcast cap); taken after the control row, before any broadcast row. */
async function lockCapacity(tx: TransactionClient) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('whatsapp-broadcast-capacity'))");
}

/** Correlation id of an automatic run: carried by every audit event of its delivery. */
function autoCorrelation(runId: string) {
  return `broadcast-auto-${runId}`;
}

export function commandFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function broadcastSelect() {
  return `SELECT b.*, u.username updated_by_username FROM whatsapp_broadcasts b LEFT JOIN users u ON u.user_id = b.updated_by`;
}

// Metadata-only schedule join: the frozen minute of the run's own generation.
function runSelect() {
  return `SELECT r.run_id, r.broadcast_id, r.business_date, r.target_date, r.kind, r.parent_run_id, r.state, r.reason, r.order_count,
    r.total_area, r.destination_chat_id, r.created_at, r.updated_at, r.image_expires_at, r.scheduled_at, r.superseded_at,
    (SELECT count(*)::int FROM whatsapp_broadcast_messages m WHERE m.run_id = r.run_id) message_count,
    (SELECT count(*)::int FROM whatsapp_broadcast_messages m WHERE m.run_id = r.run_id AND m.state = 'sent') sent_message_count
    FROM whatsapp_broadcast_runs r`;
}

function mapBroadcast(row: BroadcastRow): Broadcast {
  return {
    id: Number(row.broadcast_id), version: Number(row.version), name: row.name, enabled: row.enabled, groupChatId: row.group_chat_id,
    weekdays: row.weekdays.map(Number), sendTime: time5(row.send_time), sendWindowMinutes: Number(row.send_window_minutes),
    catchUpPolicy: row.catch_up_policy as Broadcast['catchUpPolicy'], catchUpDeadline: time5(row.catch_up_deadline),
    partialPolicy: row.partial_policy as Broadcast['partialPolicy'], orderDateOffsetDays: Number(row.order_date_offset_days),
    cardsPerMessage: Number(row.cards_per_message) as 1 | 2, captionTemplate: row.caption_template, archived: Boolean(row.archived_at),
    scheduleGeneration: Number(row.schedule_generation), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by === null ? null : { id: String(row.updated_by), username: row.updated_by_username ?? null },
  };
}

function mapControl(row: ControlRow): BroadcastControl {
  return {
    paused: row.paused, version: Number(row.version), pausedAt: row.paused_at?.toISOString() ?? null,
    pausedBy: row.paused_by === null ? null : { id: String(row.paused_by), username: row.paused_by_username ?? null },
  };
}

function mapSchedule(row: ScheduleRow): BroadcastSchedule {
  return {
    broadcastId: Number(row.broadcast_id), businessDate: isoDate(row.business_date), generation: Number(row.generation),
    scheduledAt: row.scheduled_at.toISOString(), windowStart: time5(row.window_start), windowEnd: time5(row.window_end),
    sendWindowMinutes: Number(row.send_window_minutes), catchUpPolicy: row.catch_up_policy as BroadcastSchedule['catchUpPolicy'],
    catchUpDeadline: time5(row.catch_up_deadline), settingsVersion: Number(row.settings_version), createdAt: row.created_at.toISOString(),
  };
}

function mapRun(row: RunRow): BroadcastRun {
  return {
    id: row.run_id, broadcastId: Number(row.broadcast_id), businessDate: isoDate(row.business_date), targetDate: isoDate(row.target_date),
    kind: row.kind, parentRunId: row.parent_run_id, state: row.state, reason: row.reason, orderCount: Number(row.order_count),
    totalArea: Number(row.total_area), messageCount: Number(row.message_count ?? 0), sentMessageCount: Number(row.sent_message_count ?? 0),
    destinationMasked: maskDestination(row.destination_chat_id), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    expiresAt: row.image_expires_at?.toISOString() ?? null, scheduledAt: row.scheduled_at?.toISOString() ?? null, superseded: Boolean(row.superseded_at),
  };
}

function mapMessage(row: MessageRow): BroadcastMessage {
  return {
    deliverySeq: Number(row.delivery_seq), kind: row.message_kind, orderIds: Array.isArray(row.order_ids) ? row.order_ids : [],
    state: row.state, attemptCount: Number(row.attempt_count), errorCode: row.error_code, sentAt: row.sent_at?.toISOString() ?? null,
    imageAvailable: Boolean(row.image_available), expiresAt: row.expires_at.toISOString(),
  };
}

/** Audit view of the settings: the destination is masked, the caption is hashed. */
function auditSettings(row: BroadcastRow) {
  return {
    name: row.name, enabled: row.enabled, groupChatId: maskDestination(row.group_chat_id ?? ''),
    // The mask hides which group it is; a short one-way fingerprint still shows that it changed.
    groupFingerprint: row.group_chat_id ? createHash('sha256').update(row.group_chat_id).digest('hex').slice(0, 12) : null,
    weekdays: row.weekdays.map(Number),
    sendTime: time5(row.send_time), sendWindowMinutes: Number(row.send_window_minutes), catchUpPolicy: row.catch_up_policy,
    catchUpDeadline: time5(row.catch_up_deadline), partialPolicy: row.partial_policy, orderDateOffsetDays: Number(row.order_date_offset_days),
    cardsPerMessage: Number(row.cards_per_message), captionSha256: createHash('sha256').update(row.caption_template).digest('hex'),
    captionLength: row.caption_template.length, archived: Boolean(row.archived_at),
  };
}

export function maskDestination(value: string) {
  return value.replace(/^(\d{2})[\d-]+(@g\.us)$/, '$1***$2');
}

function time5(value: string) {
  return String(value).slice(0, 5);
}

function isoDate(value: string | Date) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function mapWriteError(error: unknown): unknown {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: string; constraint?: string }).code;
    if (code === '23505') return new ApiError(409, 'BROADCAST_NAME_TAKEN', 'Рассылка с таким названием уже есть');
    if (code === '23514') return new ApiError(422, 'VALIDATION_ERROR', 'Некорректные настройки рассылки');
  }
  return error;
}

const notFound = () => new ApiError(404, 'BROADCAST_NOT_FOUND', 'Рассылка не найдена');
const runNotFound = () => new ApiError(404, 'BROADCAST_RUN_NOT_FOUND', 'Запуск рассылки не найден');
const archived = () => new ApiError(409, 'BROADCAST_ARCHIVED', 'Рассылка в архиве');
const paused = () => new ApiError(409, 'BROADCASTS_PAUSED', 'Все рассылки остановлены');
const superseded = () => new ApiError(409, 'BROADCAST_RUN_SUPERSEDED', 'Запуск заменён перепланированием; повтор невозможен');
const versionConflict = () => new ApiError(409, 'BROADCAST_VERSION_CONFLICT', 'Рассылка уже изменена; обновите страницу');

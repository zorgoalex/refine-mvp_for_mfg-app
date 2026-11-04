import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ApiError } from '../../common/errors/api-error';
import { auditService } from '../../common/audit/audit.service';
import type { DatabaseService } from '../../database/database.service';
import type { TransactionClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import { requireMdfCommandBoundary } from '../mdf-board/application/mdf-command-boundary';
import { assertCurrentWorkerSessionInTransaction } from '../cnc-telegram/adapters/cnc-telegram-worker-session-fencing';
import type { CncTelegramWorkerSessionLeaseContext } from '../cnc-telegram/application/cnc-telegram-worker-session.types';
import {
  completeCncTelegramPacketFromSignal,
  mdfCompletionUpdateSql,
} from '../cnc-telegram/adapters/pg-cnc-telegram-repository';
import {
  AUTHORS_RECHECK_MS, AUTO_APPLY_STATES, MANUAL_APPLY_STATES, POSITIVE_OBSERVATION_MAX_AGE_MS, MAX_APPLY_ATTEMPTS, MDF_RETRY_LATER_CODES, OBSERVATION_WINDOW_DAYS,
  decideApply, diffEpisodes, initialApplyState, nextPollDelayMs, resolveMessageRoles, retryDelayMs,
  roleOpensPacketSignal, signalFreshness, signalOrigin,
  type ApplyState, type BlockedReason, type MessageRole, type OpenEpisode, type ReportedReactor,
} from './cnc-chat-signals.domain';
import type {
  SawnSignalApplyConfirmDto, SawnSignalClaimResponse, SawnSignalListQuery, SawnSignalListResponse,
  SawnSignalPreviewItem, SawnSignalReportDto, SawnSignalSettingsDto, SawnSignalEffect, SawnSignalConfirmResult,
} from './cnc-chat-signals.dto';

export const CNC_SAWN_SIGNAL_CAPABILITY = 'cnc_sawn_signal_observation_v1';
const APPLY_TO_PACKET_KEY = 'cnc_chat_signals.apply_to_packet';
const ACTIVATED_AT_KEY = 'cnc_chat_signals.activated_at';
const CLAIM_TTL_MS = 5 * 60_000;
const CLAIM_BATCH = 100;
const REGISTER_BATCH = 500;
const AUDIT_SOURCE = 'backend-cnc-chat-signals';
const APPLY_WRITER = { writer: 'cnc.chat_signal.apply', capability: 'queued' } as const;
const RESET_WRITER = { writer: 'cnc.chat_signal.return_reset', capability: 'queued' } as const;

type ApplyMode = 'auto' | 'manual' | 'preview';
interface CommandItem { key: string; owner: string }
interface ApplyInput {
  packetSignalId: number; mode: ApplyMode; actor: CurrentUser; requestId: string; expectedDigest?: string;
  idempotencyKey: string; commandItem?: CommandItem;
}
export type ApplyOutcome =
  | { result: 'applied'; effect: SawnSignalEffect; effectDigest: string }
  | { result: 'held'; state: ApplyState; reason: BlockedReason }
  | { result: 'blocked'; reason: BlockedReason }
  | { result: 'retry_later'; reason: 'read_only' }
  | { result: 'stale_conflict' }
  | { result: 'preview'; eligible: boolean; reason: BlockedReason | null; effect: SawnSignalEffect; effectDigest: string;
      applyState: ApplyState };

class PreviewRollback extends Error {
  constructor(readonly outcome: ApplyOutcome) { super('preview rollback'); }
}
class StaleConflictRollback extends Error {
  constructor() { super('stale conflict rollback'); }
}

interface PacketSignalRow {
  packet_signal_id: string;
  packet_id: string;
  apply_state: ApplyState;
  closed_observed_at: string | null;
  last_positive_observed_at: string;
  apply_attempts: number;
  origin: 'live' | 'baseline';
  freshness: 'fresh' | 'late';
  opened_at: string;
  reacted_at: string | null;
}

interface MessageRow {
  chat_id: string;
  message_id: string;
  send_request_id: string;
  packet_id: string | null;
  message_role: MessageRole;
  send_finished_at: string;
  observation_state: 'never_polled' | 'present' | 'missing';
  thumbs_count: number;
  last_successful_poll_at: string | null;
  cutting_sequence_no: number | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function staleClaim(): ApiError {
  return new ApiError(409, 'CNC_SAWN_SIGNAL_CLAIM_STALE', 'Заявка опроса сигналов устарела или принадлежит другой сессии');
}

function actorFields(user: CurrentUser) {
  return { actorUserId: user.id, actorUsername: user.username ?? null, actorRole: user.role ?? null };
}

export class PgCncChatSignalsRepository {
  constructor(private readonly database: DatabaseService) {}

  // ───────────────────────── worker: claim ─────────────────────────

  async claim(input: {
    currentUser: CurrentUser; lease: CncTelegramWorkerSessionLeaseContext; requestId: string;
  }): Promise<SawnSignalClaimResponse> {
    return this.database.transaction(async (tx) => {
      await assertCurrentWorkerSessionInTransaction(tx, input.lease);
      const chatId = input.lease.sourceChatId;
      await this.ensureActivatedAt(tx, input.currentUser);
      await this.registerSentMessages(tx, chatId);
      const due = await tx.query<{ message_id: string; thumbs_count: number; authors_checked_at: string | null;
        packet_id: string | null }>(`
        SELECT message_id::text, thumbs_count, authors_checked_at, packet_id::text
          FROM cnc_chat_signal_messages
         WHERE chat_id=$1 AND next_poll_at <= now()
           AND send_finished_at >= now() - make_interval(days => $2)
           AND (claim_expires_at IS NULL OR claim_expires_at < now())
         ORDER BY next_poll_at, message_id
         LIMIT $3
         FOR UPDATE SKIP LOCKED`, [chatId, OBSERVATION_WINDOW_DAYS, CLAIM_BATCH]);
      if (due.rows.length === 0) return { capability: CNC_SAWN_SIGNAL_CAPABILITY, claim: null };
      const claimId = randomUUID();
      const claimToken = randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + CLAIM_TTL_MS);
      const packetIds = [...new Set(due.rows.map((row) => row.packet_id).filter((id): id is string => !!id))];
      const returnRefs = await this.latestReturnRefs(tx, packetIds);
      const messageIds = due.rows.map((row) => Number(row.message_id));
      await tx.query(`
        INSERT INTO cnc_chat_signal_claims (claim_id, claim_token_hash, chat_id, worker_instance_id, lease_generation,
          expires_at, message_ids, packet_return_refs)
        VALUES ($1,$2,$3,$4::uuid,$5,$6,$7::jsonb,$8::jsonb)`,
      [claimId, sha256(claimToken), chatId, input.lease.workerInstanceId, input.lease.leaseGeneration,
        expiresAt.toISOString(), JSON.stringify(messageIds), JSON.stringify(Object.fromEntries(returnRefs))]);
      await tx.query(`
        UPDATE cnc_chat_signal_messages
           SET claimed_by=$3::uuid, claim_expires_at=$4, next_poll_at=$4, last_polled_at=now(),
               poll_attempts=poll_attempts+1
         WHERE chat_id=$1 AND message_id = ANY($2::bigint[])`,
      [chatId, messageIds, claimId, expiresAt.toISOString()]);
      const now = Date.now();
      return {
        capability: CNC_SAWN_SIGNAL_CAPABILITY,
        claim: {
          claimId, claimToken, expiresAt: expiresAt.toISOString(),
          messages: due.rows.map((row) => ({
            messageId: Number(row.message_id),
            lastThumbsCount: Number(row.thumbs_count),
            authorsDue: Number(row.thumbs_count) > 0
              && (!row.authors_checked_at || now - new Date(row.authors_checked_at).getTime() >= AUTHORS_RECHECK_MS),
          })),
        },
      };
    });
  }

  /** Activation is the baseline boundary: set by the first worker claim, never by the migration (F7). */
  private async ensureActivatedAt(tx: TransactionClient, user: CurrentUser): Promise<Date> {
    const existing = await tx.query<{ value: string }>(
      `SELECT value_json->>'value' AS value FROM app_settings WHERE setting_key=$1`, [ACTIVATED_AT_KEY]);
    if (existing.rows[0]?.value) return new Date(existing.rows[0].value);
    const inserted = await tx.query<{ value: string }>(`
      INSERT INTO app_settings (setting_key, value_json, description, is_active, created_by, edited_by)
      VALUES ($1, jsonb_build_object('value', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
              'Момент запуска опроса сигналов «Распилено» (граница «до запуска»)', true, $2, $2)
      ON CONFLICT (setting_key) DO NOTHING
      RETURNING value_json->>'value' AS value`, [ACTIVATED_AT_KEY, Number(user.id)]);
    if (inserted.rows[0]?.value) {
      await auditService.record(tx, {
        event: 'cnc.chat_signal.setting_changed', entityType: 'app_setting', entityId: ACTIVATED_AT_KEY,
        ...actorFields(user), requestId: `cnc-chat-signal-activate:${randomUUID()}`, source: AUDIT_SOURCE,
        after: { activatedAt: inserted.rows[0].value }, metadata: { setting: ACTIVATED_AT_KEY },
      });
      return new Date(inserted.rows[0].value);
    }
    const again = await tx.query<{ value: string }>(
      `SELECT value_json->>'value' AS value FROM app_settings WHERE setting_key=$1`, [ACTIVATED_AT_KEY]);
    return new Date(again.rows[0]!.value);
  }

  /** Lazily registers bot-sent messages of sent manual sends inside the window, with their role (F17). */
  private async registerSentMessages(tx: TransactionClient, chatId: string): Promise<void> {
    const sends = await tx.query<{ request_id: string; packet_id: string | null; finished_at: string;
      sent_message_ids_json: unknown; file_count: number }>(`
      SELECT r.request_id::text, r.packet_id::text, r.finished_at, r.sent_message_ids_json,
             (SELECT count(*)::int FROM cnc_manual_svg_telegram_send_request_files f WHERE f.request_id=r.request_id) AS file_count
        FROM cnc_manual_svg_telegram_send_requests r
       WHERE r.status='sent' AND r.sent_chat_id=$1 AND r.finished_at >= now() - make_interval(days => $2)
         AND jsonb_typeof(r.sent_message_ids_json)='array' AND jsonb_array_length(r.sent_message_ids_json) > 0
         AND NOT EXISTS (SELECT 1 FROM cnc_chat_signal_messages m WHERE m.send_request_id=r.request_id)
       ORDER BY r.finished_at
       LIMIT $3`, [chatId, OBSERVATION_WINDOW_DAYS, REGISTER_BATCH]);
    for (const send of sends.rows) {
      const ids = (Array.isArray(send.sent_message_ids_json) ? send.sent_message_ids_json : [])
        .map((value) => String(value)).filter((value) => /^[1-9][0-9]{0,18}$/.test(value));
      if (ids.length === 0) continue;
      const audited = await tx.query<{ sent_telegram_message_id: string; is_comment: boolean }>(`
        SELECT sent_telegram_message_id::text, (COALESCE(btrim(reply_text),'') <> '') AS is_comment
          FROM cnc_telegram_worker_operations
         WHERE operation_type='telegram_reply' AND sent_telegram_message_id::text = ANY($1::text[])
           AND ($2::uuid IS NULL OR packet_id IS NULL OR packet_id=$2::uuid)`, [ids, send.packet_id]);
      const auditRoles = new Map<string, 'file' | 'comment'>(
        audited.rows.map((row) => [row.sent_telegram_message_id, row.is_comment ? 'comment' : 'file']));
      const roles = resolveMessageRoles({ sentMessageIds: ids, fileCount: Number(send.file_count), auditRoles });
      for (const id of ids) {
        const role = roles.get(id)!;
        await tx.query(`
          INSERT INTO cnc_chat_signal_messages (chat_id, message_id, send_request_id, packet_id, message_role, role_source,
            send_finished_at)
          VALUES ($1,$2,$3::uuid,$4::uuid,$5,$6,$7)
          ON CONFLICT (chat_id, message_id) DO NOTHING`,
        [chatId, id, send.request_id, send.packet_id, role.role, role.source, send.finished_at]);
        if (role.role === 'unknown') {
          await auditService.record(tx, {
            event: 'cnc.chat_signal.role_unknown', entityType: 'cnc_chat_message', entityId: `${chatId}:${id}`,
            actorUserId: null, requestId: `cnc-chat-signal-register:${send.request_id}`, source: AUDIT_SOURCE,
            metadata: { chatId, messageId: id, sendRequestId: send.request_id, packetId: send.packet_id,
              fileCount: Number(send.file_count), sentMessageCount: ids.length },
          });
        }
      }
    }
  }

  private async latestReturnRefs(tx: TransactionClient, packetIds: string[]): Promise<Map<string, string | null>> {
    const refs = new Map<string, string | null>(packetIds.map((id) => [id, null]));
    if (packetIds.length === 0) return refs;
    const rows = await tx.query<{ packet_id: string; audit_id: string }>(`
      SELECT DISTINCT ON (a.entity_id) substr(a.entity_id, 8) AS packet_id, a.audit_id::text
        FROM audit_log a
       WHERE a.entity_type='mdf_board_card' AND a.event='mdf_board.production_returned'
         AND a.entity_id = ANY(SELECT 'packet:' || unnest($1::text[]))
       ORDER BY a.entity_id, a.created_at DESC, a.audit_id DESC`, [packetIds]);
    for (const row of rows.rows) refs.set(row.packet_id, row.audit_id);
    return refs;
  }

  // ───────────────────────── worker: report ─────────────────────────

  async report(input: {
    currentUser: CurrentUser; lease: CncTelegramWorkerSessionLeaseContext; requestId: string; report: SawnSignalReportDto;
  }): Promise<{ accepted: true; replay: boolean; openedSignalIds: number[] }> {
    const { report } = input;
    const digest = sha256(canonical(report));
    return this.database.transaction(async (tx) => {
      await assertCurrentWorkerSessionInTransaction(tx, input.lease);
      const claim = (await tx.query<{ chat_id: string; worker_instance_id: string; claim_token_hash: string;
        lease_generation: string; expires_at: string; message_ids: number[]; packet_return_refs: Record<string, string | null>;
        reported_at: string | null; report_digest: string | null; issued_at: Date }>(`
        SELECT chat_id, worker_instance_id::text, claim_token_hash, lease_generation::text, expires_at, message_ids,
               packet_return_refs, reported_at, report_digest, issued_at
          FROM cnc_chat_signal_claims WHERE claim_id=$1::uuid FOR UPDATE`, [report.claimId])).rows[0];
      if (!claim || claim.claim_token_hash !== sha256(report.claimToken) || claim.chat_id !== input.lease.sourceChatId
        || claim.worker_instance_id !== input.lease.workerInstanceId
        || claim.lease_generation !== String(input.lease.leaseGeneration)) throw staleClaim();
      if (claim.reported_at) {
        if (claim.report_digest === digest) return { accepted: true, replay: true, openedSignalIds: [] };
        throw staleClaim();
      }
      if (new Date(claim.expires_at).getTime() < Date.now()) throw staleClaim();
      const claimed = [...claim.message_ids].map(Number).sort((a, b) => a - b);
      const reported = report.messages.map((message) => message.messageId).sort((a, b) => a - b);
      if (claimed.length !== reported.length || claimed.some((id, index) => id !== reported[index])) {
        throw new ApiError(400, 'CNC_SAWN_SIGNAL_REPORT_MISMATCH', 'Отчёт должен содержать ровно сообщения заявки');
      }
      const reportedAt = new Date(report.observedAt);
      const now = new Date();
      const issuedAt = new Date(claim.issued_at);
      if (Number.isNaN(reportedAt.getTime()) || reportedAt.getTime() > now.getTime() + 60_000
        || reportedAt.getTime() < issuedAt.getTime() - 60_000) {
        throw new ApiError(400, 'CNC_SAWN_SIGNAL_OBSERVED_AT_INVALID', 'Некорректное время наблюдения');
      }
      // The observation happened after the claim was issued; worker clock skew must not move it before that.
      const observedAt = new Date(Math.max(reportedAt.getTime(), issuedAt.getTime()));
      const chatId = claim.chat_id;
      const activatedAt = await this.ensureActivatedAt(tx, input.currentUser);
      const applyToPacket = await this.applyToPacket(tx);
      const requestId = input.requestId;
      const touchedPackets = new Map<string, { observedFile: boolean }>();
      const firstPositive = new Map<string, { message: MessageRow; firstPoll: boolean; reactedAt: Date | null;
        previousSuccessfulPollAt: Date | null; previousThumbs: number }>();

      for (const entry of [...report.messages].sort((a, b) => a.messageId - b.messageId)) {
        const message = (await tx.query<MessageRow>(`
          SELECT m.chat_id, m.message_id::text, m.send_request_id::text, m.packet_id::text, m.message_role,
                 m.send_finished_at, m.observation_state, m.thumbs_count, m.last_successful_poll_at,
                 p.cutting_sequence_no
            FROM cnc_chat_signal_messages m
            LEFT JOIN cnc_telegram_packets p ON p.packet_id=m.packet_id
           WHERE m.chat_id=$1 AND m.message_id=$2 FOR UPDATE OF m`, [chatId, entry.messageId])).rows[0];
        if (!message) throw staleClaim();
        const sendFinishedAt = new Date(message.send_finished_at);
        const nextPollAt = new Date(now.getTime() + nextPollDelayMs(sendFinishedAt, now));
        if (entry.readError) {
          await tx.query(`UPDATE cnc_chat_signal_messages SET claimed_by=NULL, claim_expires_at=NULL,
            next_poll_at=$3 WHERE chat_id=$1 AND message_id=$2`, [chatId, entry.messageId, nextPollAt.toISOString()]);
          continue;
        }
        const openEpisodes = (await tx.query<{ signal_id: string; reactor_peer_type: OpenEpisode['peerType'];
          reactor_peer_id: string }>(`
          SELECT signal_id::text, reactor_peer_type, reactor_peer_id FROM cnc_chat_sawn_signals
           WHERE chat_id=$1 AND message_id=$2 AND cleared_observed_at IS NULL AND message_missing_observed_at IS NULL
           FOR UPDATE`, [chatId, entry.messageId])).rows
          .map((row) => ({ signalId: Number(row.signal_id), peerType: row.reactor_peer_type, peerId: row.reactor_peer_id }));
        if (message.packet_id) {
          const touched = touchedPackets.get(message.packet_id) ?? { observedFile: false };
          if (roleOpensPacketSignal(message.message_role)) touched.observedFile = true;
          touchedPackets.set(message.packet_id, touched);
        }

        if (!entry.present) {
          if (message.observation_state !== 'missing') {
            await tx.query(`UPDATE cnc_chat_sawn_signals SET message_missing_observed_at=$3, updated_at=now()
              WHERE chat_id=$1 AND message_id=$2 AND cleared_observed_at IS NULL AND message_missing_observed_at IS NULL`,
            [chatId, entry.messageId, observedAt.toISOString()]);
            await auditService.record(tx, {
              event: 'cnc.chat_signal.message_missing_observed', entityType: 'cnc_chat_message',
              entityId: `${chatId}:${entry.messageId}`, ...actorFields(input.currentUser), requestId, source: AUDIT_SOURCE,
              metadata: { chatId, messageId: entry.messageId, packetId: message.packet_id, claimId: report.claimId,
                closedEpisodes: openEpisodes.length },
            });
          }
          await tx.query(`UPDATE cnc_chat_signal_messages SET observation_state='missing', thumbs_count=0,
              last_successful_poll_at=$3, claimed_by=NULL, claim_expires_at=NULL, next_poll_at=$4
            WHERE chat_id=$1 AND message_id=$2`,
          [chatId, entry.messageId, observedAt.toISOString(), new Date(now.getTime() + 24 * 3600_000).toISOString()]);
          continue;
        }

        const diff = diffEpisodes({ thumbsCount: entry.thumbsCount, authors: entry.authors, open: openEpisodes });
        if (diff.close.length > 0) {
          await tx.query(`UPDATE cnc_chat_sawn_signals SET cleared_observed_at=$2, updated_at=now()
            WHERE signal_id = ANY($1::bigint[])`, [diff.close, observedAt.toISOString()]);
          await auditService.record(tx, {
            event: 'cnc.chat_signal.reaction_cleared_observed', entityType: 'cnc_chat_message',
            entityId: `${chatId}:${entry.messageId}`, ...actorFields(input.currentUser), requestId, source: AUDIT_SOURCE,
            metadata: { chatId, messageId: entry.messageId, packetId: message.packet_id, claimId: report.claimId,
              signalIds: diff.close, thumbsCount: entry.thumbsCount, authorsState: entry.authors?.state ?? null },
          });
        }
        const firstPoll = message.observation_state === 'never_polled';
        const origin = signalOrigin({ sendFinishedAt, activatedAt, firstPoll });
        for (const reactor of diff.open) {
          const reactedAt = reactor.reactedAt ? new Date(reactor.reactedAt) : null;
          const inserted = await tx.query<{ signal_id: string }>(`
            INSERT INTO cnc_chat_sawn_signals (chat_id, message_id, packet_id, send_request_id, cutting_sequence_no,
              message_role, reactor_peer_type, reactor_peer_id, reactor_display_name, reactor_username, reacted_at,
              first_observed_at, first_claim_id, origin, request_id)
            VALUES ($1,$2,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13::uuid,$14,$15)
            RETURNING signal_id::text`,
          [chatId, entry.messageId, message.packet_id, message.send_request_id, message.cutting_sequence_no,
            message.message_role, reactor.peerType, reactor.peerId, reactor.displayName, reactor.username,
            reactedAt?.toISOString() ?? null, observedAt.toISOString(), report.claimId, origin, requestId]);
          const auditId = await auditService.record(tx, {
            event: 'cnc.chat_signal.reaction_observed', entityType: 'cnc_chat_message',
            entityId: `${chatId}:${entry.messageId}`, ...actorFields(input.currentUser), requestId, source: AUDIT_SOURCE,
            metadata: { chatId, messageId: entry.messageId, messageRole: message.message_role, packetId: message.packet_id,
              cuttingSequenceNo: message.cutting_sequence_no, signalId: Number(inserted.rows[0]!.signal_id),
              reactorPeerType: reactor.peerType, reactorPeerId: reactor.peerId, reactorName: reactor.displayName,
              reactorUsername: reactor.username, reactedAt: reactor.reactedAt, origin, claimId: report.claimId },
          });
          await tx.query('UPDATE cnc_chat_sawn_signals SET audit_id=$2 WHERE signal_id=$1',
            [inserted.rows[0]!.signal_id, auditId]);
        }
        const positive = entry.thumbsCount > 0;
        if (positive && message.packet_id && roleOpensPacketSignal(message.message_role)
          && !firstPositive.has(message.packet_id)) {
          const knownReacted = (entry.authors?.reactors ?? [])
            .map((reactor: ReportedReactor) => (reactor.reactedAt ? new Date(reactor.reactedAt) : null))
            .filter((value): value is Date => !!value && !Number.isNaN(value.getTime()))
            .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
          firstPositive.set(message.packet_id, {
            message, firstPoll, reactedAt: knownReacted,
            previousSuccessfulPollAt: message.last_successful_poll_at ? new Date(message.last_successful_poll_at) : null,
            previousThumbs: Number(message.thumbs_count),
          });
        }
        await tx.query(`UPDATE cnc_chat_signal_messages
            SET observation_state='present', thumbs_count=$3, can_see_list=$4,
                authors_state=COALESCE($5, authors_state), authors_checked_at=CASE WHEN $5::text IS NULL THEN authors_checked_at ELSE $6 END,
                last_successful_poll_at=$6, last_positive_observed_at=CASE WHEN $3 > 0 THEN $6 ELSE last_positive_observed_at END,
                last_negative_observed_at=CASE WHEN $3 = 0 THEN $6 ELSE last_negative_observed_at END,
                claimed_by=NULL, claim_expires_at=NULL, next_poll_at=$7
          WHERE chat_id=$1 AND message_id=$2`,
        [chatId, entry.messageId, entry.thumbsCount, entry.canSeeList, entry.authors?.state ?? null,
          observedAt.toISOString(), nextPollAt.toISOString()]);
      }

      const opened: number[] = [];
      for (const [packetId, touched] of [...touchedPackets].sort(([a], [b]) => a.localeCompare(b))) {
        if (!touched.observedFile) continue;
        // Lock order shared with apply/preview/reset: packet first, then its signal (code review R3 #2). KEY SHARE is
        // what the reset/journal foreign keys need anyway; taking it up front removes the packet↔signal cycle.
        await tx.query('SELECT 1 FROM cnc_telegram_packets WHERE packet_id=$1::uuid FOR KEY SHARE', [packetId]);
        const state = (await tx.query<{ active: boolean; all_missing: boolean; any_file: boolean }>(`
          SELECT bool_or(observation_state='present' AND thumbs_count > 0) AS active,
                 bool_and(observation_state='missing') AS all_missing, count(*) > 0 AS any_file
            FROM cnc_chat_signal_messages WHERE packet_id=$1::uuid AND message_role='file'`, [packetId])).rows[0];
        const open = (await tx.query<PacketSignalRow>(`
          SELECT packet_signal_id::text, packet_id::text, apply_state, closed_observed_at, last_positive_observed_at,
                 apply_attempts, origin, freshness, opened_at, reacted_at
            FROM cnc_chat_sawn_packet_signals WHERE packet_id=$1::uuid AND closed_observed_at IS NULL FOR UPDATE`,
        [packetId])).rows[0];
        if (state?.active) {
          if (open) {
            if (!firstPositive.has(packetId)) continue;
            await tx.query(`UPDATE cnc_chat_sawn_packet_signals SET last_positive_observed_at=GREATEST(last_positive_observed_at,$2),
              updated_at=now() WHERE packet_signal_id=$1`, [open.packet_signal_id, observedAt.toISOString()]);
            await this.linkEpisodes(tx, packetId, Number(open.packet_signal_id));
            continue;
          }
          const first = firstPositive.get(packetId);
          if (!first) continue;
          const id = await this.openPacketSignal(tx, {
            packetId, first, activatedAt, observedAt, applyToPacket, claimId: report.claimId, requestId,
            currentUser: input.currentUser,
          });
          opened.push(id);
          continue;
        }
        const closeReason = state?.all_missing ? 'message_missing' : 'cleared';
        if (open) {
          const terminal = ['applied', 'already_completed'].includes(open.apply_state);
          await tx.query(`UPDATE cnc_chat_sawn_packet_signals SET closed_observed_at=$2, close_reason=$3,
              apply_state=CASE WHEN $4 THEN apply_state ELSE 'closed' END, updated_at=now()
            WHERE packet_signal_id=$1`, [open.packet_signal_id, observedAt.toISOString(), closeReason, terminal]);
          await auditService.record(tx, {
            event: 'cnc.chat_signal.sawn_closed_observed', entityType: 'cnc_telegram_packet', entityId: packetId,
            ...actorFields(input.currentUser), requestId, source: AUDIT_SOURCE,
            metadata: { packetSignalId: Number(open.packet_signal_id), closeReason, claimId: report.claimId,
              applyStateBefore: open.apply_state },
          });
        }
        if (closeReason === 'cleared') {
          await this.maybeCreateReturnReset(tx, {
            packetId, claimId: report.claimId, claimRef: claim.packet_return_refs[packetId] ?? null,
            observedAt, claimIssuedAt: new Date(claim.issued_at), packetSignalId: open ? Number(open.packet_signal_id) : null,
          });
        }
      }

      await tx.query(`UPDATE cnc_chat_signal_claims SET reported_at=now(), report_digest=$2, report_request_id=$3
        WHERE claim_id=$1::uuid`, [report.claimId, digest, requestId]);
      return { accepted: true, replay: false, openedSignalIds: opened };
    });
  }

  private async linkEpisodes(tx: TransactionClient, packetId: string, packetSignalId: number): Promise<void> {
    await tx.query(`UPDATE cnc_chat_sawn_signals SET packet_signal_id=$2, updated_at=now()
      WHERE packet_id=$1::uuid AND packet_signal_id IS NULL AND message_role='file'
        AND cleared_observed_at IS NULL AND message_missing_observed_at IS NULL`, [packetId, packetSignalId]);
  }

  private async openPacketSignal(tx: TransactionClient, input: {
    packetId: string; activatedAt: Date; observedAt: Date; applyToPacket: boolean; claimId: string; requestId: string;
    currentUser: CurrentUser;
    first: { message: MessageRow; firstPoll: boolean; reactedAt: Date | null; previousSuccessfulPollAt: Date | null;
      previousThumbs: number };
  }): Promise<number> {
    const sendFinishedAt = new Date(input.first.message.send_finished_at);
    const origin = signalOrigin({ sendFinishedAt, activatedAt: input.activatedAt, firstPoll: input.first.firstPoll });
    const freshness = origin === 'baseline' ? 'late' : signalFreshness({
      observedAt: input.observedAt, sendFinishedAt, activatedAt: input.activatedAt, reactedAt: input.first.reactedAt,
      previousSuccessfulPollAt: input.first.previousSuccessfulPollAt, previousThumbsCount: input.first.previousThumbs,
    });
    const applyState = initialApplyState({ origin, applyToPacket: input.applyToPacket });
    const inserted = await tx.query<{ packet_signal_id: string }>(`
      INSERT INTO cnc_chat_sawn_packet_signals (packet_id, opened_at, opened_claim_id, origin, freshness, reacted_at,
        last_positive_observed_at, apply_state)
      VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6,$2,$7) RETURNING packet_signal_id::text`,
    [input.packetId, input.observedAt.toISOString(), input.claimId, origin, freshness,
      input.first.reactedAt?.toISOString() ?? null, applyState]);
    const packetSignalId = Number(inserted.rows[0]!.packet_signal_id);
    await this.linkEpisodes(tx, input.packetId, packetSignalId);
    const packet = (await tx.query<{ cutting_sequence_no: number | null; order_ids: number[] }>(`
      SELECT p.cutting_sequence_no,
             COALESCE(array_agg(DISTINCT i.match_order_id) FILTER (WHERE i.match_order_id IS NOT NULL), '{}')::bigint[] AS order_ids
        FROM cnc_telegram_packets p LEFT JOIN cnc_telegram_packet_items i ON i.packet_id=p.packet_id
       WHERE p.packet_id=$1::uuid GROUP BY p.packet_id`, [input.packetId])).rows[0];
    const orderIds = (packet?.order_ids ?? []).map(Number);
    const auditId = await auditService.record(tx, {
      event: 'cnc.chat_signal.sawn_received', entityType: 'cnc_telegram_packet', entityId: input.packetId,
      ...actorFields(input.currentUser), requestId: input.requestId, source: AUDIT_SOURCE,
      relatedOrderId: orderIds.length === 1 ? orderIds[0] : null,
      metadata: { packetSignalId, cuttingSequenceNo: packet?.cutting_sequence_no ?? null, origin, freshness,
        applyState, chatId: input.first.message.chat_id, messageId: Number(input.first.message.message_id),
        reactedAt: input.first.reactedAt?.toISOString() ?? null, claimId: input.claimId, orderIds },
      relatedEntities: orderIds.map((orderId) => ({ entityType: 'order', entityId: orderId })),
    });
    await tx.query('UPDATE cnc_chat_sawn_packet_signals SET open_audit_id=$2 WHERE packet_signal_id=$1',
      [packetSignalId, auditId]);
    const payload = {
      packetSignalId, packetId: input.packetId, cuttingSequenceNo: packet?.cutting_sequence_no ?? null, origin, freshness,
      chatId: input.first.message.chat_id, messageId: Number(input.first.message.message_id),
      reactedAt: input.first.reactedAt?.toISOString() ?? null, observedAt: input.observedAt.toISOString(),
      orderIds, auditId, requestId: input.requestId, actorUserId: input.currentUser.id,
    };
    await enqueueOutbox(tx, {
      eventType: 'cnc.chat_signal.sawn_received', aggregateType: 'cnc_telegram_packet', aggregateId: input.packetId,
      idempotencyKey: `cnc-chat-signal:${packetSignalId}:sawn-received`, payload,
    });
    if (freshness === 'fresh') {
      for (const orderId of orderIds) {
        await enqueueOutbox(tx, {
          eventType: 'order.cnc_sawn_signal_received', aggregateType: 'order', aggregateId: String(orderId),
          idempotencyKey: `cnc-chat-signal:${packetSignalId}:order:${orderId}`,
          payload: { ...payload, orderId, eventType: 'order.cnc_sawn_signal_received' },
        });
      }
    }
    return packetSignalId;
  }

  /** F16/F18: a reset is bound to the return generation captured at claim issue and to this negative observation. */
  private async maybeCreateReturnReset(tx: TransactionClient, input: {
    packetId: string; claimId: string; claimRef: string | null; observedAt: Date; claimIssuedAt: Date;
    packetSignalId: number | null;
  }): Promise<void> {
    const packet = (await tx.query<{ returned: boolean }>(
      'SELECT mdf_completion_returned AS returned FROM cnc_telegram_packets WHERE packet_id=$1::uuid', [input.packetId])).rows[0];
    if (!packet?.returned) return;
    // Negative evidence (R2 #2): every file message of the packet was successfully read as present with 0 👍 by a
    // claim issued after… at least this claim. A read error, a missing message or a cached zero is not evidence.
    if (!await hasFreshNegativeEvidence(tx, input.packetId, input.claimIssuedAt)) return;
    const current = (await this.latestReturnRefs(tx, [input.packetId])).get(input.packetId) ?? null;
    if (!current) return;
    if (current !== input.claimRef) {
      // A return happened after this claim was issued: this «0 👍» says nothing about it. Ask for a fresh poll.
      await tx.query(`UPDATE cnc_chat_signal_messages SET next_poll_at=now() WHERE packet_id=$1::uuid`, [input.packetId]);
      return;
    }
    await tx.query(`
      INSERT INTO cnc_chat_signal_return_resets (packet_id, packet_signal_id, return_ref, claim_id, negative_observed_at)
      SELECT $1::uuid,$2,$3,$4::uuid,$5
       WHERE NOT EXISTS (SELECT 1 FROM cnc_chat_signal_return_resets
                          WHERE packet_id=$1::uuid AND return_ref=$3 AND state='done')
      ON CONFLICT (packet_id, return_ref) WHERE state IN ('pending','retry_wait') DO NOTHING`,
    [input.packetId, input.packetSignalId, current, input.claimId, input.observedAt.toISOString()]);
  }

  // ───────────────────────── apply (one function, one transaction, one entry) ─────────────────────────

  /**
   * Applies one packet signal. Boundary first (DatabaseService opens it), then packet → signal locks, then the
   * shared completion effects (auto-cut advisory lock → orders/details) — the ingest lock order (F15).
   * `preview` runs everything and rolls back, returning the captured effect (F10); `manual` with `expectedDigest`
   * rolls back on a different effect (`stale_conflict`).
   */
  async applySignal(input: ApplyInput): Promise<ApplyOutcome> {
    try {
      return await this.database.transaction(async (tx) => {
        const boundary = await requireMdfCommandBoundary(tx, APPLY_WRITER);
        // Transaction-local actor for `set_edited_by` and audit triggers; never inherited from a pooled connection.
        await tx.query("SELECT set_config('app.user_id', $1, true)", [String(input.actor.id)]);
        // A confirmation item is fenced by its command row (locked before the packet): a taken-over owner can never
        // commit an effect, and the item result commits together with the effect (code review R3 #1).
        if (input.commandItem) await fenceCommandOwner(tx, input.commandItem);
        const outcome = await this.applyInTransaction(tx, boundary, input);
        if (input.commandItem && (outcome.result === 'applied' || outcome.result === 'held' || outcome.result === 'blocked')) {
          await recordCommandItem(tx, input.commandItem, confirmResultOf(input.packetSignalId, outcome));
        }
        return outcome;
      }, { mdf: APPLY_WRITER });
    } catch (error) {
      if (error instanceof PreviewRollback) return error.outcome;
      if (error instanceof StaleConflictRollback) return { result: 'stale_conflict' };
      if (error instanceof ApiError && MDF_RETRY_LATER_CODES.includes(error.code)) {
        // Only the automatic path schedules a retry; a manual confirmation keeps the signal manual-only and the
        // user previews and confirms again after the mode returns (R2 #1).
        if (input.mode === 'auto') await this.markRetry(input.packetSignalId, error.code);
        return { result: 'retry_later', reason: 'read_only' };
      }
      if (input.mode === 'auto') {
        await this.markRetry(input.packetSignalId, error instanceof ApiError ? error.code : 'APPLY_FAILED');
        return { result: 'retry_later', reason: 'read_only' };
      }
      throw error;
    }
  }

  private async applyInTransaction(tx: TransactionClient, boundary: { mode: string; queued: boolean },
    input: ApplyInput): Promise<ApplyOutcome> {
    const head = (await tx.query<{ packet_id: string }>(
      'SELECT packet_id::text FROM cnc_chat_sawn_packet_signals WHERE packet_signal_id=$1', [input.packetSignalId])).rows[0];
    if (!head) throw new ApiError(404, 'CNC_SAWN_SIGNAL_NOT_FOUND', 'Сигнал не найден');
    const packet = (await tx.query<{ completion_status: string; thumbs_up: boolean; returned: boolean }>(`
      SELECT completion_status, thumbs_up, mdf_completion_returned AS returned
        FROM cnc_telegram_packets WHERE packet_id=$1::uuid FOR UPDATE`, [head.packet_id])).rows[0];
    const signal = (await tx.query<PacketSignalRow>(`
      SELECT packet_signal_id::text, packet_id::text, apply_state, closed_observed_at, last_positive_observed_at,
             apply_attempts, origin, freshness, opened_at, reacted_at
        FROM cnc_chat_sawn_packet_signals WHERE packet_signal_id=$1 FOR UPDATE`, [input.packetSignalId])).rows[0]!;
    if (!packet) {
      return { result: 'blocked', reason: 'closed' } as ApplyOutcome;
    }
    const missing = (await tx.query<{ missing: boolean }>(`
      SELECT bool_or(observation_state='missing') AS missing FROM cnc_chat_signal_messages
       WHERE packet_id=$1::uuid AND message_role='file'`, [head.packet_id])).rows[0]?.missing === true;
    const history = (await tx.query<{ history: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM mdf_board_manual_moves WHERE card_kind='packet' AND card_id=$1)
          OR EXISTS (SELECT 1 FROM audit_log WHERE entity_type='mdf_board_card' AND entity_id='packet:' || $1
                       AND event='mdf_board.production_returned') AS history`, [head.packet_id])).rows[0]?.history === true;
    const decision = decideApply({
      mode: input.mode, applyState: signal.apply_state, origin: signal.origin, engineQueued: boundary.queued,
      signalOpen: signal.closed_observed_at === null, anyFileMessageMissing: missing,
      lastPositiveObservedAt: new Date(signal.last_positive_observed_at), now: new Date(),
      packetCompleted: packet.completion_status === 'completed' || packet.thumbs_up,
      returnBarrier: packet.returned, returnHistory: history, applyToPacket: await this.applyToPacket(tx),
    });
    if (decision.kind === 'blocked') {
      if (input.mode === 'preview') {
        return { result: 'preview', eligible: false, reason: decision.reason, effect: emptyEffect(),
          effectDigest: '', applyState: signal.apply_state };
      }
      return { result: 'blocked', reason: decision.reason };
    }
    if (decision.kind === 'hold') {
      if (input.mode === 'preview') {
        return { result: 'preview', eligible: false, reason: decision.reason, effect: emptyEffect(),
          effectDigest: '', applyState: signal.apply_state };
      }
      // In `active` only own tables and audit_log are written (no fenced production table).
      await tx.query(`UPDATE cnc_chat_sawn_packet_signals SET apply_state=$2, updated_at=now()
        WHERE packet_signal_id=$1`, [input.packetSignalId, decision.state]);
      await auditService.record(tx, {
        event: 'cnc.chat_signal.apply_skipped', entityType: 'cnc_telegram_packet', entityId: head.packet_id,
        ...actorFields(input.actor), requestId: input.requestId, source: AUDIT_SOURCE,
        metadata: { packetSignalId: input.packetSignalId, mode: input.mode, state: decision.state,
          reason: decision.reason, mdfMode: boundary.mode },
      });
      return { result: 'held', state: decision.state, reason: decision.reason };
    }

    const before = await snapshotEffectScope(tx, head.packet_id);
    const completedAt = signal.reacted_at ?? signal.opened_at;
    const updated = (await tx.query<{ completion_status: string }>(`
      UPDATE cnc_telegram_packets
         SET ${mdfCompletionUpdateSql("'completed'", 'true', '$2')}, updated_at=now(), updated_by=$3
       WHERE packet_id=$1::uuid
      RETURNING completion_status`, [head.packet_id, completedAt, Number(input.actor.id)])).rows[0];
    if (updated?.completion_status !== 'completed') {
      if (input.mode === 'preview') {
        return { result: 'preview', eligible: false, reason: 'return_barrier', effect: emptyEffect(),
          effectDigest: '', applyState: signal.apply_state };
      }
      await tx.query(`UPDATE cnc_chat_sawn_packet_signals SET apply_state='held_return_barrier', updated_at=now()
        WHERE packet_signal_id=$1`, [input.packetSignalId]);
      return { result: 'held', state: 'held_return_barrier', reason: 'return_barrier' };
    }
    const auditId = await auditService.record(tx, {
      event: 'cnc.chat_signal.packet_applied', entityType: 'cnc_telegram_packet', entityId: head.packet_id,
      ...actorFields(input.actor), requestId: input.requestId, source: AUDIT_SOURCE,
      before: { completionStatus: packet.completion_status, thumbsUp: packet.thumbs_up },
      after: { completionStatus: 'completed', thumbsUp: true, completedAt },
      metadata: { packetSignalId: input.packetSignalId, mode: input.mode, origin: signal.origin,
        applyStateBefore: signal.apply_state, mdfMode: boundary.mode },
    });
    await completeCncTelegramPacketFromSignal(tx, {
      packetId: head.packet_id, currentUser: input.actor, requestId: input.requestId, auditId,
      idempotencyKey: `cnc-chat-signal:${input.packetSignalId}`,
    });
    const { pins, ...effect } = await captureEffect(tx, head.packet_id, before);
    const effectDigest = sha256(canonical({ effect, pins }));
    if (input.mode === 'preview') {
      throw new PreviewRollback({ result: 'preview', eligible: true, reason: null, effect, effectDigest,
        applyState: signal.apply_state });
    }
    if (input.expectedDigest !== undefined && input.expectedDigest !== effectDigest) throw new StaleConflictRollback();
    await tx.query(`UPDATE cnc_chat_sawn_packet_signals SET apply_state='applied', applied_at=now(), applied_by=$2,
        apply_audit_id=$3, apply_request_id=$4, apply_attempts=apply_attempts+1, last_apply_error=NULL, updated_at=now()
      WHERE packet_signal_id=$1`, [input.packetSignalId, Number(input.actor.id), auditId, input.requestId]);
    return { result: 'applied', effect, effectDigest };
  }

  private async markRetry(packetSignalId: number, errorCode: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      const row = (await tx.query<{ apply_attempts: number; apply_state: ApplyState }>(`
        SELECT apply_attempts, apply_state FROM cnc_chat_sawn_packet_signals WHERE packet_signal_id=$1 FOR UPDATE`,
      [packetSignalId])).rows[0];
      if (!row || !AUTO_APPLY_STATES.includes(row.apply_state)) return;
      const attempts = Number(row.apply_attempts) + 1;
      const state: ApplyState = attempts >= MAX_APPLY_ATTEMPTS ? 'failed_final' : 'retry_wait';
      await tx.query(`UPDATE cnc_chat_sawn_packet_signals SET apply_state=$2, apply_attempts=$3, last_apply_error=$4,
          next_apply_at=now() + make_interval(secs => $5), updated_at=now()
        WHERE packet_signal_id=$1`, [packetSignalId, state, attempts, errorCode.slice(0, 120), retryDelayMs(attempts) / 1000]);
    });
  }

  async dueAutoApplies(limit: number): Promise<number[]> {
    const rows = await this.database.query<{ packet_signal_id: string }>(`
      SELECT packet_signal_id::text FROM cnc_chat_sawn_packet_signals
       WHERE closed_observed_at IS NULL
         AND origin='live'
         AND (apply_state='pending' OR (apply_state='retry_wait' AND next_apply_at <= now()))
         AND last_positive_observed_at > now() - make_interval(secs => $2)
         AND NOT EXISTS (SELECT 1 FROM cnc_chat_signal_messages m
                          WHERE m.packet_id=cnc_chat_sawn_packet_signals.packet_id AND m.message_role='file'
                            AND m.observation_state='missing')
       ORDER BY COALESCE(next_apply_at, opened_at), packet_signal_id LIMIT $1`,
    [limit, POSITIVE_OBSERVATION_MAX_AGE_MS / 1000]);
    return rows.rows.map((row) => Number(row.packet_signal_id));
  }

  // ───────────────────────── return-barrier reset (F16/F18) ─────────────────────────

  async dueReturnResets(limit: number): Promise<number[]> {
    const rows = await this.database.query<{ reset_id: string }>(`
      SELECT reset_id::text FROM cnc_chat_signal_return_resets
       WHERE state IN ('pending','retry_wait') AND next_attempt_at <= now() ORDER BY reset_id LIMIT $1`, [limit]);
    return rows.rows.map((row) => Number(row.reset_id));
  }

  async runReturnReset(input: { resetId: number; actor: CurrentUser; requestId: string }): Promise<string> {
    try {
      return await this.database.transaction(async (tx) => {
        const boundary = await requireMdfCommandBoundary(tx, RESET_WRITER);
        await tx.query("SELECT set_config('app.user_id', $1, true)", [String(input.actor.id)]);
        const head = (await tx.query<{ packet_id: string }>(
          'SELECT packet_id::text FROM cnc_chat_signal_return_resets WHERE reset_id=$1', [input.resetId])).rows[0];
        if (!head) return 'noop';
        const packet = (await tx.query<{ returned: boolean }>(`SELECT mdf_completion_returned AS returned
          FROM cnc_telegram_packets WHERE packet_id=$1::uuid FOR UPDATE`, [head.packet_id])).rows[0];
        // State is (re)read under the lock: a concurrent runner that already finished leaves nothing to do (R4 #2).
        const intent = (await tx.query<{ packet_id: string; return_ref: string; negative_observed_at: string;
          state: string }>(`SELECT packet_id::text, return_ref, negative_observed_at, state
            FROM cnc_chat_signal_return_resets WHERE reset_id=$1 FOR UPDATE`, [input.resetId])).rows[0];
        if (!intent || !['pending', 'retry_wait'].includes(intent.state)) return 'noop';
        const finish = async (state: string, event: string, metadata: Record<string, unknown>) => {
          const auditId = await auditService.record(tx, {
            event, entityType: 'cnc_telegram_packet', entityId: intent.packet_id, ...actorFields(input.actor),
            requestId: input.requestId, source: AUDIT_SOURCE,
            metadata: { resetId: input.resetId, returnRef: intent.return_ref, mdfMode: boundary.mode, ...metadata },
          });
          await tx.query(`UPDATE cnc_chat_signal_return_resets SET state=$2, finished_at=now(), audit_id=$3, updated_at=now()
            WHERE reset_id=$1 AND state IN ('pending','retry_wait')`, [input.resetId, state, auditId]);
          return state;
        };
        if (boundary.queued) return finish('skipped_engine', 'cnc.chat_signal.return_reset_cancelled', { reason: 'engine_mode' });
        const current = (await this.latestReturnRefs(tx, [intent.packet_id])).get(intent.packet_id) ?? null;
        const freshPositive = (await tx.query<{ positive: boolean }>(`
          SELECT EXISTS (SELECT 1 FROM cnc_chat_signal_messages WHERE packet_id=$1::uuid AND message_role='file'
                          AND last_positive_observed_at > $2)
              OR EXISTS (SELECT 1 FROM cnc_chat_sawn_packet_signals WHERE packet_id=$1::uuid AND closed_observed_at IS NULL)
            AS positive`, [intent.packet_id, intent.negative_observed_at])).rows[0]?.positive === true;
        const negative = await hasFreshNegativeEvidence(tx, intent.packet_id, new Date(intent.negative_observed_at));
        if (!packet?.returned || current !== intent.return_ref || freshPositive || !negative) {
          return finish('cancelled_stale', 'cnc.chat_signal.return_reset_cancelled', {
            reason: !packet?.returned ? 'barrier_gone' : current !== intent.return_ref ? 'newer_return'
              : freshPositive ? 'positive_after' : 'no_negative_evidence',
          });
        }
        await tx.query(`UPDATE cnc_telegram_packets SET mdf_completion_returned=false, updated_at=now(), updated_by=$2
          WHERE packet_id=$1::uuid AND mdf_completion_returned`, [intent.packet_id, Number(input.actor.id)]);
        return finish('done', 'cnc.chat_signal.return_reset_applied', {});
      }, { mdf: RESET_WRITER });
    } catch (error) {
      if (error instanceof ApiError && MDF_RETRY_LATER_CODES.includes(error.code)) {
        await this.database.query(`UPDATE cnc_chat_signal_return_resets SET state='retry_wait', attempts=attempts+1,
            last_error=$2, next_attempt_at=now() + make_interval(secs => LEAST(300, 2 * power(2, attempts))), updated_at=now()
          WHERE reset_id=$1 AND state IN ('pending','retry_wait')`, [input.resetId, error.code]);
        return 'retry_wait';
      }
      throw error;
    }
  }

  // ───────────────────────── user: settings, journal, apply-pending ─────────────────────────

  private async applyToPacket(tx: TransactionClient): Promise<boolean> {
    const row = (await tx.query<{ value: boolean | null }>(`
      SELECT (value_json->>'value')::boolean AS value FROM app_settings WHERE setting_key=$1 AND is_active`,
    [APPLY_TO_PACKET_KEY])).rows[0];
    return row?.value === true;
  }

  async settings(): Promise<SawnSignalSettingsDto> {
    const rows = await this.database.query<{ setting_key: string; value: string | null }>(`
      SELECT setting_key, value_json->>'value' AS value FROM app_settings WHERE setting_key = ANY($1::text[])`,
    [[APPLY_TO_PACKET_KEY, ACTIVATED_AT_KEY]]);
    const map = new Map(rows.rows.map((row) => [row.setting_key, row.value]));
    return { applyToPacket: map.get(APPLY_TO_PACKET_KEY) === 'true', activatedAt: map.get(ACTIVATED_AT_KEY) ?? null };
  }

  async setApplyToPacket(input: { actor: CurrentUser; applyToPacket: boolean; idempotencyKey: string;
    requestId: string }): Promise<SawnSignalSettingsDto> {
    return this.database.transaction(async (tx) => {
      const requestHash = sha256(canonical({ applyToPacket: input.applyToPacket }));
      const replay = await this.readCommand(tx, input.idempotencyKey, 'settings', input.actor, requestHash);
      if (replay) return replay as SawnSignalSettingsDto;
      const before = await this.applyToPacket(tx);
      await tx.query(`
        INSERT INTO app_settings (setting_key, value_json, description, is_active, created_by, edited_by)
        VALUES ($1, jsonb_build_object('value', $2::boolean),
          'Переносить файл станка в «Распилено» по 👍 из чата CNC (сигнал фиксируется в журнале всегда)', true, $3, $3)
        ON CONFLICT (setting_key) DO UPDATE SET value_json=EXCLUDED.value_json, is_active=true,
          edited_by=EXCLUDED.edited_by, updated_at=now()`, [APPLY_TO_PACKET_KEY, input.applyToPacket, Number(input.actor.id)]);
      await auditService.record(tx, {
        event: 'cnc.chat_signal.setting_changed', entityType: 'app_setting', entityId: APPLY_TO_PACKET_KEY,
        ...actorFields(input.actor), requestId: input.requestId, source: AUDIT_SOURCE,
        before: { applyToPacket: before }, after: { applyToPacket: input.applyToPacket },
        metadata: { setting: APPLY_TO_PACKET_KEY },
      });
      const activated = (await tx.query<{ value: string | null }>(
        `SELECT value_json->>'value' AS value FROM app_settings WHERE setting_key=$1`, [ACTIVATED_AT_KEY])).rows[0];
      const response = { applyToPacket: input.applyToPacket, activatedAt: activated?.value ?? null };
      await this.saveCommand(tx, input.idempotencyKey, 'settings', input.actor, requestHash, response);
      return response;
    });
  }

  private async readCommand(tx: TransactionClient, key: string, command: string, actor: CurrentUser,
    requestHash: string): Promise<unknown | null> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`cnc-chat-signal-command:${key}`]);
    const row = (await tx.query<{ command: string; actor_user_id: string; request_hash: string; response: unknown }>(`
      SELECT command, actor_user_id::text, request_hash, response FROM cnc_chat_signal_commands WHERE idempotency_key=$1`,
    [key])).rows[0];
    if (!row) return null;
    if (row.command !== command || row.actor_user_id !== String(actor.id) || row.request_hash !== requestHash) {
      throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Ключ повтора уже использован для другой команды');
    }
    return row.response;
  }

  private async saveCommand(tx: TransactionClient, key: string, command: string, actor: CurrentUser,
    requestHash: string, response: unknown): Promise<void> {
    await tx.query(`INSERT INTO cnc_chat_signal_commands (idempotency_key, command, actor_user_id, request_hash, response)
      VALUES ($1,$2,$3,$4,$5::jsonb)`, [key, command, Number(actor.id), requestHash, JSON.stringify(response)]);
  }

  async list(query: SawnSignalListQuery): Promise<SawnSignalListResponse> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace('$?', `$${params.length}`)); };
    if (query.from) add('s.first_observed_at >= $?', query.from);
    if (query.to) add('s.first_observed_at <= $?', query.to);
    if (query.cuttingSequenceNo) add('s.cutting_sequence_no = $?', query.cuttingSequenceNo);
    if (query.applyState) add('ps.apply_state = $?', query.applyState);
    if (query.openOnly) where.push('s.cleared_observed_at IS NULL AND s.message_missing_observed_at IS NULL');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.database.query<{ total: string }>(`
      SELECT count(*)::text AS total FROM cnc_chat_sawn_signals s
        LEFT JOIN cnc_chat_sawn_packet_signals ps ON ps.packet_signal_id = COALESCE(s.packet_signal_id,
          (SELECT o.packet_signal_id FROM cnc_chat_sawn_packet_signals o WHERE o.packet_id=s.packet_id AND o.closed_observed_at IS NULL))
      ${whereSql}`, params);
    const offset = (query.page - 1) * query.pageSize;
    const rows = await this.database.query<Record<string, unknown>>(`
      SELECT s.signal_id::text, s.chat_id, s.message_id::text, s.message_role, s.packet_id::text, s.cutting_sequence_no,
             job.source_display_number::text AS cut_job_display_number,
             s.reactor_peer_type, s.reactor_peer_id, s.reactor_display_name, s.reactor_username, s.reacted_at,
             s.first_observed_at, s.cleared_observed_at, s.message_missing_observed_at, s.origin,
             ps.packet_signal_id::text, ps.apply_state, ps.freshness, ps.applied_at, ps.closed_observed_at AS packet_closed_at
        FROM cnc_chat_sawn_signals s
        LEFT JOIN cnc_chat_sawn_packet_signals ps ON ps.packet_signal_id = COALESCE(s.packet_signal_id,
          (SELECT o.packet_signal_id FROM cnc_chat_sawn_packet_signals o WHERE o.packet_id=s.packet_id AND o.closed_observed_at IS NULL))
        LEFT JOIN cnc_telegram_packets p ON p.packet_id=s.packet_id
        LEFT JOIN cut_job job ON job.cut_job_id=p.svg_cut_job_id
      ${whereSql}
       ORDER BY s.first_observed_at DESC, s.signal_id DESC
       LIMIT ${query.pageSize} OFFSET ${offset}`, params);
    const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
    return {
      items: rows.rows.map((row) => ({
        signalId: Number(row.signal_id), chatId: String(row.chat_id), messageId: Number(row.message_id),
        messageRole: row.message_role as MessageRole, packetId: (row.packet_id as string | null) ?? null,
        cuttingSequenceNo: row.cutting_sequence_no === null ? null : Number(row.cutting_sequence_no),
        cutJobDisplayNumber: (row.cut_job_display_number as string | null) ?? null,
        reactor: row.reactor_peer_type === 'anonymous' ? null : {
          peerType: row.reactor_peer_type as 'user' | 'channel' | 'chat', peerId: String(row.reactor_peer_id),
          displayName: (row.reactor_display_name as string | null) ?? null, username: (row.reactor_username as string | null) ?? null,
        },
        reactedAt: iso(row.reacted_at), firstObservedAt: iso(row.first_observed_at)!,
        clearedObservedAt: iso(row.cleared_observed_at), messageMissingObservedAt: iso(row.message_missing_observed_at),
        origin: row.origin as 'live' | 'baseline',
        packetSignal: row.packet_signal_id ? {
          packetSignalId: Number(row.packet_signal_id), applyState: row.apply_state as ApplyState,
          freshness: row.freshness as 'fresh' | 'late', appliedAt: iso(row.applied_at), closedObservedAt: iso(row.packet_closed_at),
        } : null,
      })),
      total: Number(total.rows[0]?.total ?? 0), page: query.page, pageSize: query.pageSize,
      settings: await this.settings(),
    };
  }

  async manualCandidates(ids: number[] | undefined): Promise<Array<{ packetSignalId: number; packetId: string;
    cuttingSequenceNo: number | null; applyState: ApplyState }>> {
    const rows = await this.database.query<{ packet_signal_id: string; packet_id: string; cutting_sequence_no: number | null;
      apply_state: ApplyState }>(`
      SELECT ps.packet_signal_id::text, ps.packet_id::text, p.cutting_sequence_no, ps.apply_state
        FROM cnc_chat_sawn_packet_signals ps JOIN cnc_telegram_packets p ON p.packet_id=ps.packet_id
       WHERE ps.closed_observed_at IS NULL
         AND ($1::bigint[] IS NULL OR ps.packet_signal_id = ANY($1::bigint[]))
         AND ($1::bigint[] IS NOT NULL OR ps.apply_state = ANY($2::text[]))
       ORDER BY p.cutting_sequence_no NULLS LAST, ps.packet_signal_id
       LIMIT 200`, [ids ?? null, [...MANUAL_APPLY_STATES, 'held_engine', 'held_return_barrier']]);
    return rows.rows.map((row) => ({ packetSignalId: Number(row.packet_signal_id), packetId: row.packet_id,
      cuttingSequenceNo: row.cutting_sequence_no === null ? null : Number(row.cutting_sequence_no), applyState: row.apply_state }));
  }

  async recordPreviewAudit(input: { actor: CurrentUser; requestId: string; items: SawnSignalPreviewItem[] }): Promise<void> {
    await this.database.transaction(async (tx) => {
      await auditService.record(tx, {
        event: 'cnc.chat_signal.apply_pending_previewed', entityType: 'cnc_chat_signals', entityId: 'apply-pending',
        ...actorFields(input.actor), requestId: input.requestId, source: AUDIT_SOURCE,
        metadata: { items: input.items.map((item) => ({ packetSignalId: item.packetSignalId, eligible: item.eligible,
          blockedReason: item.blockedReason, effectDigest: item.effectDigest,
          details: item.effect.details.length, orders: item.effect.orders.length })) },
      });
    });
  }

  /**
   * «Применить накопленные» (R1 #4, R2 #3): the idempotency key is reserved BEFORE any effect by one owner with an
   * execution lease. A concurrent request with the same key gets 409 while the lease is alive; after a crash the
   * lease expires and a replay takes over, resuming the missing items. Item results are written only by the
   * current owner while the command is in progress; a `done` receipt is immutable and returned to every replay.
   */
  async confirmCommand(input: { actor: CurrentUser; dto: SawnSignalApplyConfirmDto; requestId: string;
    applyItem: (item: SawnSignalApplyConfirmDto['items'][number], commandItem: CommandItem) => Promise<SawnSignalConfirmResult> }):
    Promise<{ results: SawnSignalConfirmResult[] }> {
    const key = input.dto.idempotencyKey;
    const requestHash = sha256(canonical(input.dto.items));
    const owner = randomUUID();
    const leaseSeconds = 120;
    const leaseUntil = () => new Date(Date.now() + leaseSeconds * 1000).toISOString();
    type Receipt = { state?: string; owner?: string; leaseUntil?: string; results?: Record<string, SawnSignalConfirmResult> };
    const reserved = await this.database.transaction(async (tx) => {
      const existing = await this.readCommand(tx, key, 'apply_pending_confirm', input.actor, requestHash) as Receipt | null;
      if (existing?.state === 'done') return existing;
      if (!existing) {
        const claimed: Receipt = { state: 'in_progress', owner, leaseUntil: leaseUntil(), results: {} };
        await this.saveCommand(tx, key, 'apply_pending_confirm', input.actor, requestHash, claimed);
        return claimed;
      }
      // Takeover only of an expired lease; owner and lease change atomically, stored results are kept.
      const taken = (await tx.query<{ response: Receipt }>(`UPDATE cnc_chat_signal_commands
          SET response = response || jsonb_build_object('owner', $2::text, 'leaseUntil', $3::text)
        WHERE idempotency_key=$1 AND response->>'state'='in_progress'
          AND (response->>'leaseUntil')::timestamptz < now()
        RETURNING response`, [key, owner, leaseUntil()])).rows[0];
      if (!taken) {
        throw new ApiError(409, 'CNC_SAWN_SIGNAL_CONFIRM_IN_PROGRESS', 'Это подтверждение уже выполняется, повторите позже');
      }
      return taken.response;
    });
    const stored: Record<string, SawnSignalConfirmResult> = { ...(reserved.results ?? {}) };
    const ordered = () => input.dto.items.map((item) => stored[String(item.packetSignalId)]!);
    if (reserved.state === 'done') return { results: ordered() };
    const ownerWrite = async (sql: string, params: unknown[]) => {
      const updated = await this.database.query(sql, params);
      if ((updated.rowCount ?? 0) !== 1) {
        throw new ApiError(409, 'CNC_SAWN_SIGNAL_CONFIRM_TAKEN_OVER', 'Подтверждение перехвачено другим повтором');
      }
    };
    const commandItem: CommandItem = { key, owner };
    for (const item of input.dto.items) {
      if (stored[String(item.packetSignalId)]) continue;
      const result = await input.applyItem(item, commandItem);
      stored[String(item.packetSignalId)] = result;
      // Effectful results were already recorded inside the effect transaction; this write records the effect-free
      // ones (stale_conflict, retry_later) and renews the lease — only while we still own the command.
      await ownerWrite(`UPDATE cnc_chat_signal_commands
          SET response = jsonb_set(jsonb_set(response, ARRAY['results', $2::text], $3::jsonb), '{leaseUntil}', to_jsonb($5::text))
        WHERE idempotency_key=$1 AND response->>'state'='in_progress' AND response->>'owner'=$4`,
      [key, String(item.packetSignalId), JSON.stringify(result), owner, leaseUntil()]);
    }
    const response = { results: ordered() };
    await this.database.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`cnc-chat-signal-command:${key}`]);
      const done = await tx.query(`UPDATE cnc_chat_signal_commands
          SET response = jsonb_build_object('state','done','results',$2::jsonb)
        WHERE idempotency_key=$1 AND response->>'state'='in_progress' AND response->>'owner'=$3`,
      [key, JSON.stringify(stored), owner]);
      if ((done.rowCount ?? 0) !== 1) {
        throw new ApiError(409, 'CNC_SAWN_SIGNAL_CONFIRM_TAKEN_OVER', 'Подтверждение перехвачено другим повтором');
      }
      await auditService.record(tx, {
        event: 'cnc.chat_signal.apply_pending_executed', entityType: 'cnc_chat_signals', entityId: 'apply-pending',
        ...actorFields(input.actor), requestId: input.requestId, source: AUDIT_SOURCE,
        metadata: { results: response.results },
      });
    });
    return response;
  }
}

async function fenceCommandOwner(tx: TransactionClient, item: CommandItem): Promise<void> {
  const row = (await tx.query<{ state: string | null; owner: string | null }>(`
    SELECT response->>'state' AS state, response->>'owner' AS owner FROM cnc_chat_signal_commands
     WHERE idempotency_key=$1 FOR UPDATE`, [item.key])).rows[0];
  if (row?.state !== 'in_progress' || row.owner !== item.owner) {
    throw new ApiError(409, 'CNC_SAWN_SIGNAL_CONFIRM_TAKEN_OVER', 'Подтверждение перехвачено другим повтором');
  }
}

async function recordCommandItem(tx: TransactionClient, item: CommandItem, result: SawnSignalConfirmResult): Promise<void> {
  await tx.query(`UPDATE cnc_chat_signal_commands
      SET response = jsonb_set(response, ARRAY['results', $2::text], $3::jsonb)
    WHERE idempotency_key=$1 AND response->>'state'='in_progress' AND response->>'owner'=$4`,
  [item.key, String(result.packetSignalId), JSON.stringify(result), item.owner]);
}

/** Confirmation result of one item; a re-applied (already applied) item is reported as applied. */
export function confirmResultOf(packetSignalId: number, outcome: ApplyOutcome): SawnSignalConfirmResult {
  if (outcome.result === 'applied') return { packetSignalId, result: 'applied' };
  if (outcome.result === 'stale_conflict') return { packetSignalId, result: 'stale_conflict' };
  if (outcome.result === 'retry_later') return { packetSignalId, result: 'retry_later' };
  if (outcome.result === 'blocked' && outcome.reason === 'already_applied') return { packetSignalId, result: 'applied' };
  if (outcome.result === 'blocked' || outcome.result === 'held') return { packetSignalId, result: 'blocked', reason: outcome.reason };
  return { packetSignalId, result: 'blocked', reason: 'not_eligible' };
}

/** Every file message of the packet is present, shows 0 👍 and was successfully read at or after `since`. */
async function hasFreshNegativeEvidence(tx: TransactionClient, packetId: string, since: Date): Promise<boolean> {
  const row = (await tx.query<{ files: number; negative: number }>(`
    SELECT count(*)::int AS files,
           count(*) FILTER (WHERE observation_state='present' AND thumbs_count=0
                              AND last_negative_observed_at IS NOT NULL AND last_negative_observed_at >= $2)::int AS negative
      FROM cnc_chat_signal_messages WHERE packet_id=$1::uuid AND message_role='file'`, [packetId, since])).rows[0];
  return !!row && row.files > 0 && row.files === row.negative;
}

function emptyEffect(): SawnSignalEffect {
  return { details: [], orders: [], events: [] };
}

interface ScopeSnapshot {
  details: Map<number, { orderId: number; orderName: string; detailNumber: number | null; status: string | null }>;
  orders: Map<number, { orderName: string; orderStatus: string | null; productionStatus: string | null; version: number }>;
}

/** Orders the completion can touch: the packet's matched orders and every order placed in its cut result (mixed
 * baths). Rows changed outside this scope are still caught after the apply by their transaction id. */
async function snapshotEffectScope(tx: TransactionClient, packetId: string): Promise<ScopeSnapshot> {
  const orderIds = (await tx.query<{ order_id: string }>(`
    SELECT DISTINCT i.match_order_id::text AS order_id FROM cnc_telegram_packet_items i
     WHERE i.packet_id=$1::uuid AND i.match_order_id IS NOT NULL
    UNION
    SELECT DISTINCT pl.order_id::text FROM cnc_telegram_packets p
      JOIN cut_result_placement pl ON pl.cut_result_id = p.svg_cut_result_id
     WHERE p.packet_id=$1::uuid AND pl.order_id IS NOT NULL`, [packetId])).rows.map((row) => Number(row.order_id));
  return readScope(tx, orderIds);
}

async function readScope(tx: TransactionClient, orderIds: number[]): Promise<ScopeSnapshot> {
  const details = new Map<number, { orderId: number; orderName: string; detailNumber: number | null; status: string | null }>();
  const orders = new Map<number, { orderName: string; orderStatus: string | null; productionStatus: string | null; version: number }>();
  if (orderIds.length === 0) return { details, orders };
  const detailRows = await tx.query<{ detail_id: string; order_id: string; order_name: string; detail_number: number | null;
    status: string | null }>(`
    SELECT d.detail_id::text, d.order_id::text, o.order_name, d.detail_number, ps.production_status_name AS status
      FROM order_details d JOIN orders o ON o.order_id=d.order_id
      LEFT JOIN production_statuses ps ON ps.production_status_id=d.production_status_id
     WHERE d.order_id = ANY($1::bigint[]) AND d.delete_flag=false`, [orderIds]);
  for (const row of detailRows.rows) {
    details.set(Number(row.detail_id), { orderId: Number(row.order_id), orderName: row.order_name,
      detailNumber: row.detail_number === null ? null : Number(row.detail_number), status: row.status });
  }
  const orderRows = await tx.query<{ order_id: string; order_name: string; order_status: string | null;
    production_status: string | null; version: number }>(`
    SELECT o.order_id::text, o.order_name, os.order_status_name AS order_status,
           ps.production_status_name AS production_status, o.version
      FROM orders o LEFT JOIN order_statuses os ON os.order_status_id=o.order_status_id
      LEFT JOIN production_statuses ps ON ps.production_status_id=o.production_status_id
     WHERE o.order_id = ANY($1::bigint[])`, [orderIds]);
  for (const row of orderRows.rows) {
    orders.set(Number(row.order_id), { orderName: row.order_name, orderStatus: row.order_status,
      productionStatus: row.production_status, version: Number(row.version) });
  }
  return { details, orders };
}

/**
 * Rows written by THIS transaction, including its sub-transactions (savepoints): their xmin is not older than our
 * top-level xid and is still in progress. Rows of other transactions are either invisible (uncommitted) or committed,
 * so they never match. The 64-bit xid is rebuilt from our epoch (wraparound inside one apply is not a concern).
 */
const OWN_ROW_SQL = (alias: string) => `(${alias}.xmin::text::bigint >= (pg_current_xact_id()::text::bigint % 4294967296)
  AND pg_xact_status((((pg_current_xact_id()::text::bigint >> 32) << 32) | ${alias}.xmin::text::bigint)::text::xid8) = 'in progress')`;

/**
 * The full effect of the apply inside this transaction (F10): every order/detail row this transaction changed
 * (found by its xmin, so mixed-bath orders outside the matched scope are included) with version, before-state where
 * known, the packet after-state, every enqueued event with its aggregate, and the pins of the inputs that decided
 * the result (enabled automation rules with their versions, the two settings). Any difference → another digest.
 */
async function captureEffect(tx: TransactionClient, packetId: string, before: ScopeSnapshot):
  Promise<SawnSignalEffect & { pins: Record<string, unknown> }> {
  const changedOrderIds = (await tx.query<{ order_id: string }>(`
    SELECT order_id::text FROM orders o WHERE ${OWN_ROW_SQL('o')}
    UNION SELECT order_id::text FROM order_details d WHERE ${OWN_ROW_SQL('d')}`)).rows.map((row) => Number(row.order_id));
  const changedDetailIds = new Set((await tx.query<{ detail_id: string }>(
    `SELECT detail_id::text FROM order_details d WHERE ${OWN_ROW_SQL('d')}`)).rows.map((row) => Number(row.detail_id)));
  const after = await readScope(tx, [...new Set([...before.orders.keys(), ...changedOrderIds])]);
  const versions = new Map((await tx.query<{ detail_id: string; version: number }>(
    'SELECT detail_id::text, version FROM order_details WHERE detail_id = ANY($1::bigint[])', [[...changedDetailIds]]))
    .rows.map((row) => [Number(row.detail_id), Number(row.version)]));
  const details = [...after.details].flatMap(([detailId, now]) => {
    const was = before.details.get(detailId);
    if (!changedDetailIds.has(detailId) && was && was.status === now.status) return [];
    if (was && was.status === now.status && !changedDetailIds.has(detailId)) return [];
    return [{ detailId, orderId: now.orderId, orderName: now.orderName, detailNumber: now.detailNumber,
      statusBefore: was ? was.status : null, statusAfter: now.status, version: versions.get(detailId) ?? null }];
  }).filter((detail) => detail.statusBefore !== detail.statusAfter || changedDetailIds.has(detail.detailId))
    .sort((a, b) => a.detailId - b.detailId);
  const orders = [...after.orders].flatMap(([orderId, now]) => {
    const was = before.orders.get(orderId);
    if (was && was.orderStatus === now.orderStatus && was.productionStatus === now.productionStatus
      && was.version === now.version) return [];
    return [{ orderId, orderName: now.orderName, orderStatusBefore: was?.orderStatus ?? null, orderStatusAfter: now.orderStatus,
      productionStatusBefore: was?.productionStatus ?? null, productionStatusAfter: now.productionStatus,
      versionBefore: was?.version ?? null, versionAfter: now.version }];
  }).sort((a, b) => a.orderId - b.orderId);
  const eventRows = (await tx.query<{ event_type: string; aggregate_type: string; aggregate_id: string }>(`
    SELECT event_type, aggregate_type, aggregate_id::text FROM outbox_events e WHERE ${OWN_ROW_SQL('e')}`)).rows;
  const events = eventRows.map((row) => row.event_type).sort();
  const packet = (await tx.query<Record<string, unknown>>(`
    SELECT completion_status, thumbs_up, completed_at, mdf_completion_returned, source_version
      FROM cnc_telegram_packets WHERE packet_id=$1::uuid`, [packetId])).rows[0] ?? null;
  const rules = (await tx.query<{ id: string; version: number }>(
    'SELECT id::text, version FROM status_automation_rules WHERE is_enabled ORDER BY id')).rows
    .map((row) => `${row.id}:${row.version}`);
  const settings = (await tx.query<{ setting_key: string; value: unknown }>(`
    SELECT setting_key, value_json AS value FROM app_settings
     WHERE setting_key = ANY($1::text[]) ORDER BY setting_key`,
  [['status_automation.cnc_mark_cut_details', 'cnc_chat_signals.apply_to_packet']])).rows;
  return {
    details: details.map(({ version: _version, ...detail }) => detail),
    orders: orders.map(({ versionBefore: _before, versionAfter: _after, ...order }) => order),
    events,
    pins: {
      detailVersions: details.map((detail) => [detail.detailId, detail.version]),
      orderVersions: orders.map((order) => [order.orderId, order.versionBefore, order.versionAfter]),
      eventAggregates: eventRows.map((row) => `${row.event_type}|${row.aggregate_type}|${row.aggregate_id}`).sort(),
      packet: packet ? { ...packet, completed_at: packet.completed_at ? new Date(packet.completed_at as string).toISOString() : null } : null,
      rules, settings,
    },
  };
}

async function enqueueOutbox(tx: TransactionClient, input: {
  eventType: string; aggregateType: string; aggregateId: string; idempotencyKey: string; payload: Record<string, unknown>;
}): Promise<void> {
  await tx.query(`
    INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
    VALUES ($1, $2, $3, $4::jsonb, $5)
    ON CONFLICT (idempotency_key) DO NOTHING`,
  [input.eventType, input.aggregateType, input.aggregateId, JSON.stringify(input.payload), input.idempotencyKey]);
}

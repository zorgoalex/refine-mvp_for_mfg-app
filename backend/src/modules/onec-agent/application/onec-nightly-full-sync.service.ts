import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import { PgOnecRepository } from '../adapters/pg-onec-repository';
import { OnecRuntimeConfigService } from '../onec-runtime-config.service';
import { OnecAuditWriter } from './onec-audit';
import { OnecCommandWakeups } from './onec-command-wakeups';
import { OnecCommandsService } from './onec-commands.service';
import { buildOnecEvent } from '../domain/onec-events';

const HOUR_MS = 60 * 60_000;
/**
 * The night slot may start late (backend restart, busy agent) but not later than this after its hour; the command
 * expires at the same moment — ERP never delivers it later (21:00 UTC → latest 01:00 UTC = 06:00 Almaty), so a full
 * sync never starts in the working day (code review R1-2).
 */
export const NIGHTLY_WINDOW_MS = 4 * HOUR_MS;
export const MISSED_ALERT_KIND = 'onec_nightly_full_sync_missed';
/** Audit event: the schedule started watching an agent at this hour — nights before it are never "missed". */
export const ACTIVATED_EVENT = 'onec.nightly_full_sync.activated';
/** `hourUtc` of the activation record that marks the schedule switched off. */
const OFF_HOUR = -1;
/** Statuses of a start_full_sync that did not (and will not) run: they do not satisfy the night. */
const FAILED_STATUSES = ['business_error', 'dead_letter', 'expired', 'cancelled', 'expired_undelivered'];
/** Full scope = all enabled entities (agent: `entities: []`); a partial operator sync does not satisfy the night. */
const FULL_SCOPE_PAYLOAD = '{"entities":[]}';
const CHECK_EVERY_MS = 5 * 60_000;
export const NIGHTLY_SOURCE_MODULE = 'onec_nightly';
const ACTOR = 'onec-nightly-full-sync';

export interface NightlySlot {
  /** UTC date of the slot start, YYYY-MM-DD (part of the idempotency key: one command per agent per night). */
  date: string;
  startsAt: Date;
  expiresAt: Date;
}

/** The latest slot whose start (`hourUtc:00`) is not after `now`, regardless of the window. */
export function latestSlot(now: Date, hourUtc: number): NightlySlot {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc));
  if (start.getTime() > now.getTime()) start.setUTCDate(start.getUTCDate() - 1);
  return { date: start.toISOString().slice(0, 10), startsAt: start, expiresAt: new Date(start.getTime() + NIGHTLY_WINDOW_MS) };
}

/** The latest slot whose window has already closed at `now` (the night to check for a miss). */
export function latestClosedSlot(now: Date, hourUtc: number): NightlySlot {
  const latest = latestSlot(now, hourUtc);
  if (now.getTime() >= latest.expiresAt.getTime()) return latest;
  const start = new Date(latest.startsAt.getTime() - 24 * HOUR_MS);
  return { date: start.toISOString().slice(0, 10), startsAt: start, expiresAt: new Date(start.getTime() + NIGHTLY_WINDOW_MS) };
}

/**
 * The night slot `now` belongs to: the latest `hourUtc:00` not after `now`, if `now` is within NIGHTLY_WINDOW_MS of it.
 * null — outside the window (no command is due).
 */
export function nightlySlot(now: Date, hourUtc: number): NightlySlot | null {
  const slot = latestSlot(now, hourUtc);
  return now.getTime() < slot.expiresAt.getTime() ? slot : null;
}

export function nightlyIdempotencyKey(agentId: string, slot: NightlySlot): string {
  return `onec-nightly-full-sync:${agentId}:${slot.date}`;
}

/**
 * Nightly full export (agent to-erp/0101/0102): with a windowed hourly incremental (`readScope: delta`) only a full read
 * marks rows that disappeared in 1C, so ERP sends `start_full_sync` once a night per active agent
 * (BACKEND_ONEC_NIGHTLY_FULL_SYNC_HOUR_UTC; -1 = off). One command per agent per night by the idempotency key; skipped when
 * a full sync of this agent is already open or was created since the slot start (an operator's run counts). Owner-gated
 * like the monitor, one active process by an advisory lock.
 */
@Injectable()
export class OnecNightlyFullSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OnecNightlyFullSyncService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
    @Inject(PgOnecRepository) private readonly repository: PgOnecRepository,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OnecCommandsService) private readonly commands: OnecCommandsService,
    @Inject(OnecAuditWriter) private readonly audit: OnecAuditWriter,
    @Inject(OnecCommandWakeups) private readonly wakeups: OnecCommandWakeups,
  ) {}

  onModuleInit(): void {
    const config = this.runtime.get();
    // The timer also runs with the schedule off (-1): it records the "off" period, so a later re-enable at the same hour
    // starts a new activation period instead of reporting the disabled nights (code review R5-1).
    if (!config.enabled || config.monitorOwner !== 'in_process') return;
    this.timer = setInterval(() => void this.tick(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.database.withAdvisoryLock('onec-nightly-full-sync', () => this.schedule(now));
    } catch (error) {
      this.logger.error(`1C nightly full sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Enqueues the night's full sync for every active agent that needs it; returns the agents a command was created for. */
  async schedule(now: Date): Promise<string[]> {
    const config = this.runtime.get();
    if (!config.enabled) return [];
    const agents = await this.repository.listAgentsForMonitor();
    // Off (-1) is a period too: recorded once per change, never matches a schedule hour.
    for (const row of agents) await this.recordActivation(String(row.agent_id), Number(row.source_id), config.nightlyFullSyncHourUtc ?? OFF_HOUR, now);
    if (config.nightlyFullSyncHourUtc === null) return [];
    const slot = nightlySlot(now, config.nightlyFullSyncHourUtc);
    // The latest CLOSED night is checked on every tick, also while the next window is open (code review R3-1: an owner
    // recovering during the next night must still report the missed previous one). Idempotent per agent and night.
    await this.reconcileMissed(agents, latestClosedSlot(now, config.nightlyFullSyncHourUtc), config.nightlyFullSyncHourUtc);
    if (!slot) return [];
    const created: string[] = [];
    for (const row of agents) {
      const agentId = String(row.agent_id);
      try {
        if (await this.enqueueFor(agentId, slot, now)) created.push(agentId);
      } catch (error) {
        // One agent's failure must not stop the others; the next check retries within the window.
        this.logger.error(`1C nightly full sync for ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return created;
  }

  /**
   * After the window: for each active agent, the night is satisfied only by a full-scope start_full_sync created in
   * the window that did not fail (nightly or operator). Otherwise a warning alert per agent and night (deduplicated,
   * not reopened by later checks); it stays for the operator. Alerts are only raised for the latest closed night and only
   * after nightly scheduling ran for the agent at least once before (enabling the schedule does not alert for the past night).
   */
  async reconcileMissed(agents: ReadonlyArray<QueryResultRow>, slot: NightlySlot, hourUtc: number): Promise<string[]> {
    const missed: string[] = [];
    for (const row of agents) {
      const agentId = String(row.agent_id);
      const sourceId = Number(row.source_id);
      await this.database.transaction(async (tx) => {
        if (await this.satisfied(tx, agentId, slot, 'window')) return;
        // Only nights covered by the schedule at THIS hour: the latest activation before the slot start must be for this
        // hour (code review R2-4, R3-2, R4-1: an activation is recorded on every hour change, so a period at another hour —
        // also a return to an earlier hour — never reports nights it did not watch).
        const activated = (await tx.query<{ ok: boolean }>(
          `SELECT COALESCE((SELECT (metadata_json->>'hourUtc')::int = $4 FROM audit_log
              WHERE event = $1 AND entity_type = 'onec_agent' AND entity_id = $2 AND created_at <= $3
              ORDER BY created_at DESC, audit_id DESC LIMIT 1), false) AS ok`,
          [ACTIVATED_EVENT, agentId, slot.startsAt, hourUtc],
        )).rows[0]?.ok === true;
        if (!activated) return;
        const nightly = (await tx.query<{ status: string }>(
          `SELECT status FROM onec_agent_commands WHERE source_module = $1 AND idempotency_key = $2`,
          [NIGHTLY_SOURCE_MODULE, nightlyIdempotencyKey(agentId, slot)],
        )).rows[0];
        const requestId = `${ACTOR}:${slot.date}`;
        // Domain event through the module outbox (code review R2-3); the projector raises the one-shot alert.
        await this.repository.insertOutboxEvent(tx, buildOnecEvent({
          eventType: 'onec.etl.nightly_full_sync_missed',
          severity: 'warning',
          actor: { kind: 'system', id: ACTOR },
          agentId,
          sourceId,
          subject: { type: 'onec_agent', id: agentId },
          requestId,
          correlationId: null,
          data: {
            slot: slot.date, slotStart: slot.startsAt.toISOString(), deadline: slot.expiresAt.toISOString(),
            reason: nightly ? `nightly_command_${nightly.status}` : 'not_enqueued',
          },
          idempotencyKey: `onec.etl.nightly_full_sync_missed:${agentId}:${slot.date}`,
        }));
        missed.push(agentId);
      });
    }
    return missed;
  }

  /**
   * On every change of the schedule hour for an agent (and the first time): a system audit record marks when the schedule
   * started watching the agent at this hour — the start of an activation period.
   */
  private async recordActivation(agentId: string, sourceId: number, hourUtc: number, now: Date): Promise<void> {
    await this.database.transaction(async (tx) => {
      const { rows } = await tx.query<{ hour: number | null }>(
        `SELECT (metadata_json->>'hourUtc')::int AS hour FROM audit_log WHERE event = $1 AND entity_type = 'onec_agent' AND entity_id = $2
          ORDER BY created_at DESC, audit_id DESC LIMIT 1`,
        [ACTIVATED_EVENT, agentId],
      );
      if (rows[0] && rows[0].hour === hourUtc) return;
      await this.audit.bySystem(tx, ACTOR, `${ACTOR}:activated:${agentId}:${hourUtc}:${now.toISOString()}`, {
        event: ACTIVATED_EVENT,
        entityType: 'onec_agent',
        entityId: agentId,
        after: { hourUtc, windowHours: NIGHTLY_WINDOW_MS / HOUR_MS },
        metadata: { hourUtc, activatedAt: now.toISOString() },
      }, { agentId, sourceId });
    });
  }

  /**
   * `window`: the night is fulfilled — a full-scope start_full_sync of the agent was delivered (received by the agent)
   * before the deadline and did not fail (code review R2-1: creation time alone does not count; a deferred or
   * never-delivered command does not satisfy the night).
   * `busy`: fulfilled, or a full-scope sync is still open and deliverable before the deadline (not deferred past it,
   * not expired) — do not enqueue a second one now.
   */
  private async satisfied(tx: DatabaseClient, agentId: string, slot: NightlySlot, mode: 'window' | 'busy'): Promise<boolean> {
    const { rows } = await tx.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM onec_agent_commands
          WHERE agent_id = $1 AND command_type = 'start_full_sync' AND payload_canonical = $2
            AND ((received_at >= $3 AND received_at < $4 AND NOT (status = ANY($5::text[])))
              OR ($6 AND status IN ('queued', 'leased', 'received')
                  AND (not_before_utc IS NULL OR not_before_utc < $4)
                  AND (expires_at_utc IS NULL OR expires_at_utc > now())))) AS ok`,
      [agentId, FULL_SCOPE_PAYLOAD, slot.startsAt, slot.expiresAt, FAILED_STATUSES, mode === 'busy'],
    );
    return rows[0]?.ok === true;
  }

  private async enqueueFor(agentId: string, slot: NightlySlot, now: Date): Promise<boolean> {
    const requestId = `${ACTOR}:${slot.date}`;
    // One correlation id per attempt, stored on the command: receipt/result audit and events of the run carry it.
    const correlationId = randomUUID();
    const created = await this.database.transaction(async (tx) => {
      // Skip when the night is already satisfied or a full-scope sync is open. A concurrent operator full sync may still
      // slip in between (different idempotency keys): a duplicate full sync is safe, only wasteful (accepted, code review R1-5).
      if (await this.satisfied(tx, agentId, slot, 'busy')) return false;
      const enqueued = await this.commands.enqueue(tx, {
        agentId,
        commandType: 'start_full_sync',
        payload: { entities: [] },
        correlationId,
        expiresAtUtc: slot.expiresAt.toISOString(),
        requestedBy: { displayName: ACTOR },
        sourceModule: NIGHTLY_SOURCE_MODULE,
        sourceEntityType: 'onec_agent',
        sourceEntityId: agentId,
        idempotencyKey: nightlyIdempotencyKey(agentId, slot),
      });
      if (!enqueued.created) return false;
      await this.audit.bySystem(
        tx,
        ACTOR,
        requestId,
        {
          event: 'onec.command.enqueued',
          entityType: 'onec_agent_command',
          entityId: enqueued.command.commandId,
          after: {
            commandType: enqueued.command.commandType,
            payloadHash: enqueued.command.payloadHash,
            payloadBytes: enqueued.command.payloadBytes,
            priority: enqueued.command.priority,
            reason: 'nightly_full_sync',
            slot: slot.date,
            expiresAtUtc: slot.expiresAt.toISOString(),
          },
          metadata: { scheduledAt: now.toISOString() },
        },
        { agentId, sourceId: enqueued.command.sourceId, commandId: enqueued.command.commandId, correlationId: enqueued.command.correlationId ?? correlationId },
      );
      return true;
    });
    if (created) {
      this.wakeups.wake(agentId);
      this.logger.log(`1C nightly full sync enqueued for ${agentId} (slot ${slot.date})`);
    }
    return created;
  }
}

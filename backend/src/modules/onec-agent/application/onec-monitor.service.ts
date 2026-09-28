import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';
import { PgOnecCommandRepository } from '../adapters/pg-onec-command-repository';
import { PgOnecEtlRepository } from '../adapters/pg-onec-etl-repository';
import { ONEC_ETL_LIMITS } from '../domain/onec-etl';
import { attemptFiles, removeQuietly } from './onec-etl-spool';
import { PgOnecRepository } from '../adapters/pg-onec-repository';
import { OnecRuntimeConfigService } from '../onec-runtime-config.service';
import { buildOnecEvent } from '../domain/onec-events';
import { OnecAlertProjector } from './onec-alert-projector';
import { OnecAuditWriter } from './onec-audit';
import { OnecEtlRevocationService } from './onec-etl-revocation.service';

/** Monitor events are system-initiated; one request/correlation id per tick. */
function systemEventBase(now: Date) {
  const tickId = `onec-monitor:${now.toISOString()}`;
  return { actor: { kind: 'system' as const, id: 'onec-monitor' }, requestId: tickId, correlationId: tickId };
}

/** Certificate expiry warning thresholds, days (agent warns at the same points). */
export const CERT_EXPIRY_THRESHOLDS = [30, 14, 7, 3, 1] as const;
const RETENTION_EVERY_MS = 60 * 60 * 1000;
const OUTBOX_BATCH = 50;
const OUTBOX_MAX_ATTEMPTS = 10;
const OUTBOX_STALE_LOCK_MS = 10 * 60 * 1000;
const WORKER_ID = `onec-monitor-${process.pid}`;

/**
 * Owner-gated background loop (BACKEND_ONEC_MONITOR_OWNER=in_process):
 * detects silent agents and expiring certificates (events into the module
 * outbox), relays the outbox into alerts, applies retention. A global
 * advisory lock keeps one active loop across processes.
 */
@Injectable()
export class OnecMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OnecMonitorService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRetentionAt = 0;

  constructor(
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
    @Inject(PgOnecRepository) private readonly repository: PgOnecRepository,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OnecAlertProjector) private readonly projector: OnecAlertProjector,
    @Inject(PgOnecCommandRepository) private readonly commands: PgOnecCommandRepository,
    @Inject(PgOnecEtlRepository) private readonly etl: PgOnecEtlRepository,
    @Inject(OnecAuditWriter) private readonly audit: OnecAuditWriter,
    @Inject(OnecEtlRevocationService) private readonly revocation: OnecEtlRevocationService,
  ) {}

  onModuleInit(): void {
    const config = this.runtime.get();
    if (!config.enabled || config.monitorOwner !== 'in_process') return;
    this.timer = setInterval(() => void this.tick(), config.monitorIntervalMs);
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
      await this.database.withAdvisoryLock('onec-agent-monitor', async () => {
        await this.detectSilentAgents(now);
        await this.detectExpiringCertificates(now);
        await this.expireUndeliveredCommands(now);
        await this.recoverEtl(now);
        await this.revocation.cleanupAll();
        await this.relayOutbox();
        if (now.getTime() - this.lastRetentionAt >= RETENTION_EVERY_MS) {
          const removed = {
            ...(await this.repository.applyRetention()),
            commandPayloadsPurged: await this.commands.purgeOldPayloads(),
            ...(await this.etlRetention()),
          };
          this.lastRetentionAt = now.getTime();
          this.logger.log(`1C retention: ${JSON.stringify(removed)}`);
        }
      });
    } catch (error) {
      this.logger.error(`1C monitor tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  async detectSilentAgents(now: Date): Promise<void> {
    const silentAfterMs = this.runtime.get().heartbeatIntervalMs * 3;
    for (const row of await this.repository.listAgentsForMonitor()) {
      const receivedAt: Date | null = row.received_at ?? null;
      if (receivedAt && now.getTime() - receivedAt.getTime() <= silentAfterMs) continue;
      // One event per silence period: keyed by the last heartbeat time.
      const silentSince = receivedAt ? receivedAt.toISOString() : 'never';
      await this.repository.insertOutboxEvent(
        this.repository.db,
        buildOnecEvent({
          ...systemEventBase(now),
          eventType: 'onec.agent.silent',
          severity: 'critical',
          agentId: row.agent_id,
          sourceId: Number(row.source_id),
          subject: { type: 'onec_agent', id: row.agent_id },
          data: { lastHeartbeatAt: receivedAt?.toISOString() ?? null, silentSince },
          occurredAt: now,
          idempotencyKey: `onec.agent.silent:${row.agent_id}:${silentSince}`,
        }),
      );
    }
  }

  async detectExpiringCertificates(now: Date): Promise<void> {
    for (const row of await this.repository.listExpiringCertificates(CERT_EXPIRY_THRESHOLDS[0])) {
      const daysLeft = (new Date(row.not_after).getTime() - now.getTime()) / 86_400_000;
      const threshold = [...CERT_EXPIRY_THRESHOLDS].reverse().find((days) => daysLeft <= days);
      if (threshold === undefined) continue;
      await this.repository.insertOutboxEvent(
        this.repository.db,
        buildOnecEvent({
          ...systemEventBase(now),
          eventType: 'onec.certificate.expiring',
          severity: threshold <= 7 ? 'critical' : 'warning',
          agentId: row.agent_id,
          sourceId: Number(row.source_id),
          subject: { type: 'onec_agent_certificate', id: String(row.cert_id) },
          data: { certId: Number(row.cert_id), notAfter: new Date(row.not_after).toISOString(), thresholdDays: threshold },
          occurredAt: now,
          idempotencyKey: `onec.certificate.expiring:${row.cert_id}:${threshold}`,
        }),
      );
    }
  }

  /** Commands whose expiresAt passed before the agent received them (never delivered). */
  async expireUndeliveredCommands(now: Date): Promise<number> {
    return this.commands.transaction(async (tx) => {
      const expired = await this.commands.expireUndelivered(tx);
      for (const command of expired) {
        await this.repository.insertOutboxEvent(
          tx,
          buildOnecEvent({
            ...systemEventBase(now),
            eventType: 'onec.command.expired_undelivered',
            severity: 'warning',
            agentId: command.agentId,
            sourceId: command.sourceId,
            subject: { type: 'onec_agent_command', id: command.commandId },
            data: { commandId: command.commandId, commandType: command.commandType, sourceModule: command.sourceModule },
            occurredAt: now,
            idempotencyKey: `onec.command.expired_undelivered:${command.commandId}`,
          }),
        );
      }
      return expired.length;
    });
  }

  /**
   * ETL recovery (plan §6.5 step 7, §6.6): runs without complete for 24 h are
   * abandoned; reservations without a heartbeat are removed with their part
   * file; a parser that stopped (backend restart) hands its batch back; a
   * stored batch whose spool file vanished becomes invalid.
   */
  async recoverEtl(now: Date): Promise<void> {
    await this.etl.abandonStaleRuns(ONEC_ETL_LIMITS.abandonRunAfterMs, async (tx, run) => {
      const base = systemEventBase(now);
      // Same transaction as the transition: audit + event are written once, with it.
      await this.audit.bySystem(
        tx,
        'onec-monitor',
        base.requestId,
        {
          event: 'onec.etl.run_abandoned',
          entityType: 'onec_etl_run',
          entityId: run.runId,
          before: { status: 'receiving' },
          after: { status: 'abandoned', reason: 'NO_COMPLETE_24H' },
          statusField: 'status',
          statusCode: 'abandoned',
        },
        { agentId: run.agentId, sourceId: run.sourceId, sourceGeneration: run.sourceGeneration, runId: run.runId, correlationId: base.correlationId },
      );
      await this.repository.insertOutboxEvent(
        tx,
        buildOnecEvent({
          ...systemEventBase(now),
          eventType: 'onec.etl.run_abandoned',
          severity: 'warning',
          agentId: run.agentId,
          sourceId: run.sourceId,
          subject: { type: 'onec_etl_run', id: run.runId },
          data: { runId: run.runId },
          occurredAt: now,
          idempotencyKey: `onec.etl.run_abandoned:${run.runId}`,
        }),
      );
    });
    const spoolDir = this.runtime.get().etlSpoolDir;
    // Claim first (row deleted atomically, a late uploader can no longer publish), then remove its files.
    for (const stale of await this.etl.claimStaleReservations(ONEC_ETL_LIMITS.reservationStaleMs)) {
      for (const file of attemptFiles(spoolDir, { sourceId: stale.sourceId, entityCode: stale.entityCode, batchId: stale.batchId, token: stale.owner })) {
        await removeQuietly(file);
      }
    }
    await this.etl.recoverStuckParsing(ONEC_ETL_LIMITS.parseStaleMs, ONEC_ETL_LIMITS.maxParseAttempts);
    for (const batch of await this.etl.listBatchesNeedingSpool()) {
      if (await fileExists(batch.spoolPath)) continue;
      if (await this.etl.markSpoolMissing(batch.batchId)) {
        await this.repository.recordIncident(this.repository.db, {
          agentId: batch.agentId,
          kind: 'etl_batch_invalid',
          dedupeKey: `etl_batch_invalid:${batch.batchId}`,
          details: { batchId: batch.batchId, runId: batch.runId, reason: 'SPOOL_MISSING' },
          runId: batch.runId,
          batchId: batch.batchId,
        });
      }
    }
  }

  /** Spool files past 7 days, orphan files (no batch row) older than 1 h, run/batch journal past 90 days. */
  async etlRetention(): Promise<{ spoolFilesRemoved: number; orphanFilesRemoved: number; etlRunsPurged: number }> {
    let spoolFilesRemoved = 0;
    for (const file of await this.etl.listExpiredSpoolFiles(ONEC_ETL_LIMITS.spoolRetentionMs)) {
      try {
        await removeQuietly(file.path);
        await this.etl.clearSpoolPath(file.batchId, file.path);
        spoolFilesRemoved += 1;
      } catch (error) {
        this.logger.warn(`1C spool file not removed (kept for retry): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const orphanFilesRemoved = await this.sweepOrphans();
    const etlRunsPurged = await this.etl.purgeJournal(ONEC_ETL_LIMITS.journalRetentionDays);
    return { spoolFilesRemoved, orphanFilesRemoved, etlRunsPurged };
  }

  private async sweepOrphans(): Promise<number> {
    const dir = this.runtime.get().etlSpoolDir;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return 0;
    }
    const referenced = await this.etl.referencedSpoolPaths();
    // Live attempts (any reservation row) keep their files; files are named `<source>.<entity>.<batch>.<owner>.*`.
    const live = new Set((await this.etl.listStaleReservations(0)).map((r) => `${r.batchId}.${r.owner}.`));
    let removed = 0;
    for (const name of names) {
      const file = path.join(dir, name);
      if (referenced.has(file) || [...live].some((attempt) => name.includes(attempt))) continue;
      try {
        const stats = await fs.stat(file);
        if (!stats.isFile() || Date.now() - stats.mtimeMs < ONEC_ETL_LIMITS.orphanFileAgeMs) continue;
        await removeQuietly(file);
        removed += 1;
      } catch {
        // raced with an upload finishing; next sweep
      }
    }
    return removed;
  }

  async relayOutbox(): Promise<number> {
    const events = await this.repository.claimOutboxEvents(WORKER_ID, OUTBOX_BATCH, OUTBOX_STALE_LOCK_MS);
    let processed = 0;
    for (const event of events) {
      try {
        await this.repository.transaction(async (tx) => {
          await this.projector.project(tx, event);
          if (!(await this.repository.markOutboxProcessed(tx, event.eventId, WORKER_ID))) {
            throw new Error('outbox lock lost');
          }
        });
        processed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.repository.markOutboxRetry(event.eventId, WORKER_ID, message, OUTBOX_MAX_ATTEMPTS);
        this.logger.warn(`1C outbox event ${event.eventId} (${event.eventType}) failed: ${message}`);
      }
    }
    return processed;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

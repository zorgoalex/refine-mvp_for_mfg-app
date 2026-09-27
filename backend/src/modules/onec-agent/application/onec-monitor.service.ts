import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';
import { PgOnecRepository } from '../adapters/pg-onec-repository';
import { OnecRuntimeConfigService } from '../onec-runtime-config.service';
import { buildOnecEvent } from '../domain/onec-events';
import { OnecAlertProjector } from './onec-alert-projector';

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
        await this.relayOutbox();
        if (now.getTime() - this.lastRetentionAt >= RETENTION_EVERY_MS) {
          const removed = await this.repository.applyRetention();
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

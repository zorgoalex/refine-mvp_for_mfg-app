import { Inject, Injectable } from '@nestjs/common';
import type { DatabaseClient } from '../../../database/database.types';
import { PgOnecRepository, type OutboxEventRecord } from '../adapters/pg-onec-repository';

/** Agent states that need an operator's attention. */
const ATTENTION_STATES = new Set(['degraded', 'offline_onec', 'storage_critical', 'incompatible_version']);

export class UnknownOnecEventError extends Error {
  constructor(eventType: string) {
    super(`No projector for 1C event type ${eventType}`);
    this.name = 'UnknownOnecEventError';
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const int = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * Projects module events into onec_alerts (visible to onec.view users).
 * Idempotent: alerts are upserted by dedupe_key, so a replayed event never
 * creates a second alert. External delivery (Telegram etc.) is a later
 * subscriber of the same events.
 */
@Injectable()
export class OnecAlertProjector {
  constructor(@Inject(PgOnecRepository) private readonly repository: PgOnecRepository) {}

  async project(tx: DatabaseClient, event: OutboxEventRecord): Promise<void> {
    // Envelope (domain/onec-events.ts): identity at the top level, event data in `data`.
    const envelope = event.payload;
    const p: Record<string, unknown> = { ...((envelope.data as Record<string, unknown> | undefined) ?? {}), occurredAt: envelope.occurredAt };
    const agentId = str(envelope.agentId);
    const sourceId = int(envelope.sourceId);
    switch (event.eventType) {
      case 'onec.agent.silent': {
        // The agent may have recovered between detection and relay.
        const { rows } = await tx.query(`SELECT received_at FROM onec_agent_status WHERE agent_id = $1`, [agentId]);
        const receivedAt: Date | null = rows[0]?.received_at ?? null;
        const silentSince = str(p.silentSince);
        const recovered =
          receivedAt !== null && (silentSince === 'never' || (silentSince !== null && receivedAt.getTime() > Date.parse(silentSince)));
        if (recovered) return;
        await this.repository.upsertAlert(tx, {
          kind: 'agent_silent',
          agentId,
          sourceId,
          certId: null,
          severity: 'critical',
          dedupeKey: `agent_silent:${agentId}:${str(p.silentSince) ?? 'never'}`,
          details: { lastHeartbeatAt: str(p.lastHeartbeatAt), silentSince },
        });
        return;
      }
      case 'onec.agent.state_changed': {
        // Projected from the agent's CURRENT status, not from the event body:
        // a retried or replayed older event can then never close an alert
        // that reflects a newer state, and replay is a no-op.
        if (!agentId) return;
        const { rows } = await tx.query(
          `SELECT state, state_reason FROM onec_agent_status WHERE agent_id = $1 FOR UPDATE`,
          [agentId],
        );
        const state: string = rows[0]?.state ?? '';
        const reason: string = rows[0]?.state_reason ?? '';
        if (!ATTENTION_STATES.has(state)) {
          await this.repository.resolveAlerts(tx, agentId, ['agent_state']);
          return;
        }
        const dedupeKey = `agent_state:${agentId}:${state}:${reason}`;
        await this.repository.resolveAlerts(tx, agentId, ['agent_state'], dedupeKey);
        await this.repository.upsertAlert(tx, {
          kind: 'agent_state',
          agentId,
          sourceId,
          certId: null,
          severity: state === 'degraded' ? 'warning' : 'critical',
          dedupeKey,
          details: { state, stateReason: reason || null },
        });
        return;
      }
      case 'onec.certificate.expiring': {
        const certId = int(p.certId);
        const days = int(p.thresholdDays);
        // A delayed or replayed event must not reopen the alert of a certificate
        // revoked in the meantime. Lock order agent -> certificate -> alert, the
        // same as revokeCertificate (agent FOR UPDATE, then the certificate row),
        // so the two serialize instead of deadlocking on the alert's agent FK.
        await tx.query(`SELECT 1 FROM onec_agents WHERE agent_id = $1 FOR KEY SHARE`, [agentId]);
        const { rows } = await tx.query(
          `SELECT status FROM onec_agent_certificates WHERE cert_id = $1 FOR SHARE`,
          [certId],
        );
        if (rows[0]?.status !== 'active') return;
        await this.repository.upsertAlert(tx, {
          kind: 'certificate_expiring',
          agentId,
          sourceId,
          certId,
          severity: days !== null && days <= 7 ? 'critical' : 'warning',
          dedupeKey: `certificate_expiring:${certId}`,
          details: { notAfter: str(p.notAfter), thresholdDays: days },
        });
        return;
      }
      case 'onec.config.rejected':
        await this.repository.upsertAlert(tx, {
          kind: 'config_rejected',
          agentId,
          sourceId,
          certId: null,
          severity: 'critical',
          dedupeKey: `config_rejected:${agentId}:${int(p.rejectedConfigVersion)}`,
          details: { rejectedConfigVersion: int(p.rejectedConfigVersion), rejectedReason: str(p.rejectedReason) },
        });
        return;
      case 'onec.source.identity_changed':
        await this.repository.upsertAlert(tx, {
          kind: 'source_identity_changed',
          agentId,
          sourceId,
          certId: null,
          severity: 'critical',
          dedupeKey: `source_identity_changed:${sourceId}:${str(p.occurredAt) ?? ''}`,
          details: {},
        });
        return;
      case 'onec.command.completed': {
        // Only failures that need an operator become alerts; success is audit + event only.
        const status = str(p.status);
        if (status !== 'dead_letter') return;
        await this.repository.upsertAlert(tx, {
          kind: 'command_dead_letter',
          agentId,
          sourceId,
          certId: null,
          severity: 'critical',
          dedupeKey: `command_dead_letter:${str(p.commandId)}`,
          oneShot: true,
          details: { commandId: str(p.commandId), commandType: str(p.commandType), errorCode: str(p.errorCode) },
        });
        return;
      }
      case 'onec.command.expired_undelivered':
        // A late receipt may have landed before this relay: then the alert would be false.
        const expiredCommandId = str(p.commandId);
        if (expiredCommandId && (await this.repository.commandReceivedForUpdate(tx, expiredCommandId))) return;
        await this.repository.upsertAlert(tx, {
          kind: 'command_expired_undelivered',
          agentId,
          sourceId,
          certId: null,
          severity: 'warning',
          dedupeKey: `command_expired_undelivered:${str(p.commandId)}`,
          oneShot: true,
          details: { commandId: str(p.commandId), commandType: str(p.commandType) },
        });
        return;
      case 'onec.etl.run_completed': {
        // Current state wins: only the run that is still the entity's latest may open/resolve its alert.
        const runId = str(p.runId);
        const entities = Array.isArray(p.entities) ? (p.entities as Array<Record<string, unknown>>) : [];
        for (const entity of entities) {
          const code = str(entity.entity);
          if (!code || sourceId === null) continue;
          const { rows } = await tx.query(
            `SELECT last_run_id FROM onec_etl_entity_state WHERE source_id = $1 AND entity_code = $2`,
            [sourceId, code],
          );
          if (rows[0]?.last_run_id !== runId) continue;
          const dedupeKey = `etl_entity_failed:${sourceId}:${code}`;
          if (entity.status === 'failed') {
            await this.repository.upsertAlert(tx, {
              kind: 'etl_entity_failed',
              agentId,
              sourceId,
              certId: null,
              severity: 'warning',
              dedupeKey,
              details: { entity: code, runId, errorCode: str(entity.errorCode) },
            });
          } else {
            await this.repository.resolveAlertByDedupeKey(tx, dedupeKey);
          }
        }
        return;
      }
      case 'onec.etl.run_abandoned':
        await this.repository.upsertAlert(tx, {
          kind: 'etl_run_abandoned',
          agentId,
          sourceId,
          certId: null,
          severity: 'warning',
          dedupeKey: `etl_run_abandoned:${str(p.runId)}`,
          oneShot: true,
          details: { runId: str(p.runId) },
        });
        return;
      case 'onec.etl.full_sync_required':
        await this.repository.upsertAlert(tx, {
          kind: 'etl_full_sync_required',
          agentId,
          sourceId,
          certId: null,
          severity: 'warning',
          dedupeKey: `etl_full_sync_required:${str(p.runId)}`,
          oneShot: true,
          details: { runId: str(p.runId), mode: str(p.mode), completedAs: str(p.completedAs) },
        });
        return;
      default:
        throw new UnknownOnecEventError(event.eventType);
    }
  }
}

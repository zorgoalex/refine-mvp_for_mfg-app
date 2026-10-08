import type { OutboxEventInput } from '../adapters/pg-onec-repository';

/** Event types of the module outbox (onec_outbox_events). */
export type OnecEventType =
  | 'onec.agent.state_changed'
  | 'onec.agent.silent'
  | 'onec.certificate.expiring'
  | 'onec.config.rejected'
  | 'onec.source.identity_changed'
  | 'onec.command.completed'
  | 'onec.command.expired_undelivered'
  | 'onec.etl.run_completed'
  | 'onec.etl.run_abandoned'
  | 'onec.etl.full_sync_required'
  | 'onec.etl.nightly_full_sync_missed'
  | 'onec.etl.entity_revoked'
  | 'onec.etl.entity_restored'
  | 'onec.source.generation_bumped'
  | 'onec.stock_snapshot.requested'
  | 'onec.stock_snapshot.ready'
  | 'onec.stock_snapshot.failed'
  | 'onec.stock_snapshot.deleted';

export type OnecEventSeverity = 'info' | 'warning' | 'critical';

/**
 * Envelope stored with every module event so any later subscriber
 * (alerts now, Telegram/e-mail later) can reconstruct who/what/why and
 * correlate with audit rows without re-reading the producer's state.
 */
export interface OnecEventEnvelope {
  envelopeVersion: 1;
  eventType: OnecEventType;
  occurredAt: string;
  severity: OnecEventSeverity;
  actor: { kind: 'onec_agent' | 'user' | 'system'; id: string };
  agentId: string | null;
  sourceId: number | null;
  subject: { type: string; id: string };
  requestId: string;
  correlationId: string | null;
  data: Record<string, unknown>;
}

export function buildOnecEvent(input: Omit<OnecEventEnvelope, 'envelopeVersion' | 'occurredAt'> & {
  occurredAt?: Date;
  idempotencyKey: string;
}): OutboxEventInput {
  const { idempotencyKey, occurredAt, ...rest } = input;
  const envelope: OnecEventEnvelope = { envelopeVersion: 1, occurredAt: (occurredAt ?? new Date()).toISOString(), ...rest };
  return {
    eventType: input.eventType,
    aggregateType: input.subject.type,
    aggregateId: input.subject.id,
    payload: envelope as unknown as Record<string, unknown>,
    idempotencyKey,
  };
}

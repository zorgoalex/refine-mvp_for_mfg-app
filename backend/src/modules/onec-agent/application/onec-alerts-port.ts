import { Inject, Injectable } from '@nestjs/common';
import type { DatabaseClient } from '../../../database/database.types';
import { PgOnecRepository } from '../adapters/pg-onec-repository';

/**
 * Port for business modules (E4) to raise/clear their own 1C integration alerts on the
 * «1С» screen, inside the caller's transaction. Ordering between concurrent callers is the
 * caller's responsibility (e.g. a sequence checked under its own row lock).
 */
@Injectable()
export class OnecAlertsPort {
  constructor(@Inject(PgOnecRepository) private readonly repository: PgOnecRepository) {}

  async raise(
    tx: DatabaseClient,
    alert: { kind: string; sourceId: number; dedupeKey: string; severity: 'warning' | 'critical'; details: Record<string, unknown> },
  ): Promise<void> {
    const { rows } = await tx.query<{ agent_id: string }>('SELECT agent_id FROM onec_agents WHERE source_id = $1', [alert.sourceId]);
    await this.repository.upsertAlert(tx, {
      kind: alert.kind,
      agentId: rows[0]?.agent_id ?? null,
      sourceId: alert.sourceId,
      certId: null,
      severity: alert.severity,
      dedupeKey: alert.dedupeKey,
      details: alert.details,
    });
  }

  async resolve(tx: DatabaseClient, dedupeKey: string): Promise<void> {
    await this.repository.resolveAlertByDedupeKey(tx, dedupeKey);
  }
}

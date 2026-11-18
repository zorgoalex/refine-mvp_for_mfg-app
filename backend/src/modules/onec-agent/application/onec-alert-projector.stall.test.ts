import { describe, expect, it, vi } from 'vitest';
import { OnecAlertProjector } from './onec-alert-projector';

/** Incident 12–18.11.2026: «Выгрузка стоит» is critical, a successful run ends it, a run waiting for a person is critical. */
function projector(rows: (sql: string) => unknown[]) {
  const repository = { upsertAlert: vi.fn(async () => undefined), resolveAlerts: vi.fn(async () => undefined), resolveAlertByDedupeKey: vi.fn(async () => undefined) };
  const tx = { query: vi.fn(async (sql: string) => ({ rows: rows(sql) })) };
  return { repository, tx, projector: new OnecAlertProjector(repository as never) };
}
const event = (eventType: string, data: Record<string, unknown>) => ({
  eventType, payload: { agentId: 'agent-a', sourceId: 1, occurredAt: '2026-11-18T12:00:00.000Z', data },
}) as never;

describe('alert projector: ETL stall', () => {
  it('opens a critical etl_stalled keyed by the last success', async () => {
    const { repository, tx, projector: p } = projector(() => [{ last_success_at: new Date('2026-11-12T11:01:47Z') }]);
    await p.project(tx as never, event('onec.etl.stalled', { lastSuccessAt: '2026-11-12T11:01:47.000Z', since: '2026-11-12T11:01:47.000Z', thresholdMinutes: 180 }));
    expect(repository.upsertAlert).toHaveBeenCalledWith(tx, expect.objectContaining({
      kind: 'etl_stalled', severity: 'critical', dedupeKey: 'etl_stalled:agent-a:2026-11-12T11:01:47.000Z',
      details: { lastSuccessAt: '2026-11-12T11:01:47.000Z', since: '2026-11-12T11:01:47.000Z', thresholdMinutes: 180 },
    }));
  });

  it('a success after the detection: no alert', async () => {
    const { repository, tx, projector: p } = projector(() => [{ last_success_at: new Date('2026-11-18T11:30:00Z') }]);
    await p.project(tx as never, event('onec.etl.stalled', { lastSuccessAt: '2026-11-12T11:01:47.000Z', thresholdMinutes: 180 }));
    expect(repository.upsertAlert).not.toHaveBeenCalled();
  });

  const completed = (runCompletedAt: Date | null, lastSuccessAt: string | null) => projector((sql) => {
    if (sql.includes('FROM onec_etl_entity_state')) return [{ last_run_id: 'r1' }];
    if (sql.includes('FROM onec_etl_runs')) return runCompletedAt ? [{ completed_at: runCompletedAt }] : [];
    if (sql.includes('FROM onec_alerts')) return [{ dedupe_key: `etl_stalled:agent-a:${lastSuccessAt ?? 'never'}`, last_success_at: lastSuccessAt }];
    return [];
  });
  const runEvent = event('onec.etl.run_completed', { runId: 'r1', entities: [{ entity: 'items', status: 'done' }] });

  it('a successful run completed after the stall began resolves it (also a «never» stall)', async () => {
    const after = completed(new Date('2026-11-18T17:56:02Z'), '2026-11-12T11:01:47.000Z');
    await after.projector.project(after.tx as never, runEvent);
    expect(after.repository.resolveAlertByDedupeKey).toHaveBeenCalledWith(after.tx, 'etl_stalled:agent-a:2026-11-12T11:01:47.000Z');
    const never = completed(new Date('2026-11-18T17:56:02Z'), null);
    await never.projector.project(never.tx as never, runEvent);
    expect(never.repository.resolveAlertByDedupeKey).toHaveBeenCalledWith(never.tx, 'etl_stalled:agent-a:never');
  });

  it('review R1-2: a delayed or replayed event of the run the stall counts from (or older) keeps the stall open', async () => {
    const same = completed(new Date('2026-11-12T11:01:47Z'), '2026-11-12T11:01:47.000Z');
    await same.projector.project(same.tx as never, runEvent);
    expect(same.repository.resolveAlertByDedupeKey).not.toHaveBeenCalledWith(same.tx, expect.stringContaining('etl_stalled'));
    const older = completed(new Date('2026-11-11T10:00:00Z'), '2026-11-12T11:01:47.000Z');
    await older.projector.project(older.tx as never, runEvent);
    expect(older.repository.resolveAlertByDedupeKey).not.toHaveBeenCalledWith(older.tx, expect.stringContaining('etl_stalled'));
  });

  it('a run that is not a success in the database (failed entities, not completed) resolves nothing', async () => {
    const failed = completed(null, '2026-11-12T11:01:47.000Z');
    await failed.projector.project(failed.tx as never, runEvent);
    expect(failed.repository.resolveAlertByDedupeKey).not.toHaveBeenCalledWith(failed.tx, expect.stringContaining('etl_stalled'));
  });

  it('agent state degraded / ETL_RUNS_UNRESOLVED is critical; another degraded reason stays a warning', async () => {
    const stuck = projector(() => [{ state: 'degraded', state_reason: 'ETL_RUNS_UNRESOLVED' }]);
    await stuck.projector.project(stuck.tx as never, event('onec.agent.state_changed', {}));
    expect(stuck.repository.upsertAlert).toHaveBeenCalledWith(stuck.tx, expect.objectContaining({ kind: 'agent_state', severity: 'critical' }));
    const other = projector(() => [{ state: 'degraded', state_reason: 'SPOOL_HIGH' }]);
    await other.projector.project(other.tx as never, event('onec.agent.state_changed', {}));
    expect(other.repository.upsertAlert).toHaveBeenCalledWith(other.tx, expect.objectContaining({ kind: 'agent_state', severity: 'warning' }));
  });
});

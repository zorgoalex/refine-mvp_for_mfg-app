import { describe, expect, it, vi } from 'vitest';
import { OnecMonitorService } from './onec-monitor.service';

/** ERP's own `etl_reset` after a 24 h stall (agent-bridge to-onec/0192, to-erp/0219; review R2). */
function monitor(options: { existing: boolean; runs: string[] }) {
  const stored = new Set<string>(options.existing ? ['etl-auto-reset:agent-a:2026-11-12T11:01:47.000Z'] : []);
  const tx = { query: vi.fn(async () => ({ rows: options.runs.map((run_id) => ({ run_id })) })) };
  const commands = {
    transaction: async (handler: (client: unknown) => Promise<void>) => handler(tx),
    findByIdempotencyKey: vi.fn(async (_tx: unknown, _module: string, key: string) => (stored.has(key) ? { commandId: 'old' } : null)),
  };
  const enqueue = vi.fn(async (_tx: unknown, input: { idempotencyKey: string }) => {
    stored.add(input.idempotencyKey);
    return { created: true, command: { commandId: 'c1', payloadHash: 'h', sourceId: 1, correlationId: null } };
  });
  const audit = { bySystem: vi.fn(async () => 'a1') };
  const service = new OnecMonitorService(
    {} as never, {} as never, {} as never, {} as never, commands as never, {} as never, audit as never, {} as never,
    undefined, { enqueue } as never,
  );
  return { service, enqueue, audit, tx, commands };
}

const since = new Date('2026-11-12T11:01:47.000Z');
const key = since.toISOString();

describe('monitor: automatic etl_reset', () => {
  it('names only the runs of this stall (since its start) in runIds — a run started later is never reset by it', async () => {
    const { service, enqueue, tx, audit } = monitor({ existing: false, runs: ['bd162429-bdd2-41bb-b012-d0c6e835a2ef'] });
    await service.autoResetEtl('agent-a', key, since, since, new Date('2026-11-13T12:00:00Z'));
    expect(tx.query.mock.calls[0][1]).toEqual(['agent-a', since, since]);
    const sql = String(tx.query.mock.calls[0][0]);
    expect(sql).toMatch(/created_at >= \$2/);
    // Review R3-1: the stall is re-checked in the same statement (the current last success equals the one read).
    expect(sql).toMatch(/WITH last AS \(\s*SELECT max\(completed_at\)/);
    expect(sql).toMatch(/date_trunc\('milliseconds', last\.ts\) = date_trunc\('milliseconds', \$3::timestamptz\)/);
    expect(enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({
      commandType: 'etl_reset', sourceModule: 'onec-monitor', idempotencyKey: `etl-auto-reset:agent-a:${key}`,
      payload: { runIds: ['bd162429-bdd2-41bb-b012-d0c6e835a2ef'], reason: 'ERP: выгрузка стоит больше 24 часов' },
    }));
    expect(audit.bySystem).toHaveBeenCalledTimes(1);
  });

  it('two ticks of one stall: one command, one audit row, no idempotency conflict (review R2-2)', async () => {
    const { service, enqueue, audit } = monitor({ existing: false, runs: ['bd162429-bdd2-41bb-b012-d0c6e835a2ef'] });
    await service.autoResetEtl('agent-a', key, since, since, new Date('2026-11-13T12:00:00Z'));
    await service.autoResetEtl('agent-a', key, since, since, new Date('2026-11-13T12:01:00Z'));
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(audit.bySystem).toHaveBeenCalledTimes(1);
  });

  it('an existing command of the stall or no run to reset: nothing is enqueued', async () => {
    const existing = monitor({ existing: true, runs: ['bd162429-bdd2-41bb-b012-d0c6e835a2ef'] });
    await existing.service.autoResetEtl('agent-a', key, since, since, new Date('2026-11-13T12:00:00Z'));
    expect(existing.enqueue).not.toHaveBeenCalled();
    const none = monitor({ existing: false, runs: [] });
    await none.service.autoResetEtl('agent-a', key, since, since, new Date('2026-11-13T12:00:00Z'));
    expect(none.enqueue).not.toHaveBeenCalled();
  });
});

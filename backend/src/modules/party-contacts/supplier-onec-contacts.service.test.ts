import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { OnecEtlEvents } from '../onec-agent/application/onec-etl-events';
import type { SupplierOnecContactsRepository, SyncContext } from './supplier-onec-contacts.repository';
import { SupplierOnecContactsService } from './supplier-onec-contacts.service';

describe('1C contacts passes of suppliers', () => {
  it('a publication that arrives during a pass gets its own pass under its own correlation id; extra hourly passes merge', async () => {
    const seen: Array<Pick<SyncContext, 'trigger' | 'correlationId'>> = [];
    let release: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const repository = {
      targets: async () => [1],
      sync: async (_supplierId: number, ctx: SyncContext) => {
        seen.push({ trigger: ctx.trigger, correlationId: ctx.correlationId });
        if (first) { first = false; await paused; }
        return { status: 'unchanged', added: 0, removed: 0, updated: 0, skipped: 0, contactsState: 'available' };
      },
      recordPass: async () => undefined,
    } as unknown as SupplierOnecContactsRepository;
    const config = { get: () => true } as unknown as ConfigService<never, true>;
    const service = new SupplierOnecContactsService(config as never, repository, {} as OnecEtlEvents);

    const running = service.pass('hourly', 'corr-hourly');
    await Promise.resolve();
    void service.pass('published', 'corr-run-b');
    void service.pass('hourly', 'corr-hourly-2');
    void service.pass('hourly', 'corr-hourly-3');
    void service.pass('published', 'corr-run-c');
    release();
    await running;
    expect(seen).toEqual([
      { trigger: 'hourly', correlationId: 'corr-hourly' },
      { trigger: 'published', correlationId: 'corr-run-b' },
      { trigger: 'hourly', correlationId: 'corr-hourly-2' },
      { trigger: 'published', correlationId: 'corr-run-c' },
    ]);
  });
});

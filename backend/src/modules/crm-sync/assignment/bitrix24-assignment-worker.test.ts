import { describe, expect, it, vi } from 'vitest';
import { Bitrix24ApiError } from '../adapters/bitrix24-api-client';
import { Bitrix24AssignmentWorker, type AssignmentPolicy } from './bitrix24-assignment-worker';
import type {
  AssignmentRemote,
  AssignmentSettings,
  ClaimedAssignmentEntity,
  DesiredAssignment,
  PgBitrix24AssignmentRepository,
} from './pg-bitrix24-assignment-repository';

const ENTITY: ClaimedAssignmentEntity = {
  entityType: 'order',
  erpId: '501',
  version: 3,
  causeIds: [2, 3],
  processedVersion: 1,
  attempts: 0,
  leaseToken: 'lease-1',
};

function remote(overrides: Partial<AssignmentRemote> = {}): AssignmentRemote {
  return {
    bitrixObject: 'deal',
    bitrixId: '9001',
    entityType: 'order',
    erpId: '501',
    managed: false,
    originalCaptured: false,
    originalAssignedById: null,
    sentAssignedById: null,
    opId: null,
    opTarget: null,
    opEntityVersion: null,
    opCauseIds: null,
    opGeneration: null,
    opPurpose: null,
    restoreGeneration: null,
    restoreTarget: null,
    restoreCauseIds: null,
    restoreOutcome: null,
    retiredAt: null,
    ...overrides,
  };
}

const MANAGER: DesiredAssignment = { bitrixUserId: '77', erpUserId: '12', source: 'manager', orderId: null };

function setup(input: {
  settings?: Partial<AssignmentSettings>;
  remotes?: AssignmentRemote[];
  current?: { bitrixObject: 'deal'; bitrixId: string; sourceSystem: 'erp' | 'bitrix24' } | null;
  ensured?: AssignmentRemote;
  desired?: DesiredAssignment | null;
  remoteAssignedById?: string | null | Error;
  updateError?: Error;
  policy?: Partial<AssignmentPolicy>;
} = {}) {
  const settings: AssignmentSettings = { mode: 'on', generation: 1, releaseAssignedById: '1', ...input.settings };
  const store = {
    settings: vi.fn(async () => settings),
    purgeOldCauses: vi.fn(async () => undefined),
    advanceFanout: vi.fn(async () => 0),
    claimDue: vi.fn(async () => [ENTITY]),
    remotes: vi.fn(async () => input.remotes ?? []),
    currentObject: vi.fn(async () => (input.current === undefined ? { bitrixObject: 'deal', bitrixId: '9001', sourceSystem: 'erp' } : input.current)),
    ensureRemote: vi.fn(async () => input.ensured ?? remote()),
    desired: vi.fn(async () => (input.desired === undefined ? MANAGER : input.desired)),
    rememberDesired: vi.fn(async () => undefined),
    markProcessed: vi.fn(async () => undefined),
    enroll: vi.fn(async () => undefined),
    causeIdsFor: vi.fn(async () => [5, 6]),
    beginOp: vi.fn(async () => 'op-1'),
    finalize: vi.fn(async () => 'change-1'),
    clearOp: vi.fn(async () => undefined),
    defer: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    setRestoreOutcome: vi.fn(async () => undefined),
  };
  const bitrix = {
    withRequestGuard: vi.fn(async (_guard: unknown, operation: () => Promise<unknown>) => operation()),
    getCrmItem: vi.fn(async () => {
      if (input.remoteAssignedById instanceof Error) throw input.remoteAssignedById;
      return { id: 9001, assignedById: input.remoteAssignedById === undefined ? 5 : input.remoteAssignedById };
    }),
    updateCrmItem: vi.fn(async () => {
      if (input.updateError) throw input.updateError;
    }),
  };
  const worker = new Bitrix24AssignmentWorker({
    bitrix: bitrix as never,
    store: store as unknown as PgBitrix24AssignmentRepository,
    policy: () => ({ enabled: true, cohort: null, releaseAssignedById: '1', ...input.policy }),
    now: () => Date.parse('2026-10-22T12:00:00Z'),
    logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
  });
  return { worker, store, bitrix };
}

const guard = async () => undefined;

describe('Bitrix24AssignmentWorker', () => {
  it('does nothing while the flag is off or the channel is off', async () => {
    const off = setup({ policy: { enabled: false } });
    expect(await off.worker.runDue(guard)).toEqual({ processed: 0 });
    expect(off.store.claimDue).not.toHaveBeenCalled();
    const modeOff = setup({ settings: { mode: 'off' } });
    expect(await modeOff.worker.runDue(guard)).toEqual({ processed: 0 });
    expect(modeOff.store.claimDue).not.toHaveBeenCalled();
    expect(modeOff.bitrix.getCrmItem).not.toHaveBeenCalled();
  });

  it('writes the manager as responsible: operation committed first, then the call, then the confirmation', async () => {
    const { worker, store, bitrix } = setup({ remoteAssignedById: 5 });
    await worker.runDue(guard);
    expect(store.beginOp).toHaveBeenCalledWith(ENTITY, expect.objectContaining({ bitrixId: '9001' }), {
      target: '77',
      purpose: 'assign',
      generation: 1,
      current: '5',
      desiredSource: 'manager',
      desiredOrderId: null,
    });
    expect(bitrix.updateCrmItem).toHaveBeenCalledWith(2, '9001', { assignedById: 77 });
    expect(store.beginOp.mock.invocationCallOrder[0]).toBeLessThan(bitrix.updateCrmItem.mock.invocationCallOrder[0]);
    // The decision travels with the operation (a recovery journals the same before/source).
    expect(store.finalize).toHaveBeenCalledWith({
      opId: 'op-1',
      remote: expect.objectContaining({ opBefore: '5', opDesiredSource: 'manager', opTarget: '77', opEntityVersion: 3, opCauseIds: [2, 3] }),
    });
    expect(store.markProcessed).toHaveBeenCalled();
  });

  it('enrolls an object that already shows the manager, without writing', async () => {
    const { worker, store, bitrix } = setup({ remoteAssignedById: 77 });
    await worker.runDue(guard);
    expect(bitrix.updateCrmItem).not.toHaveBeenCalled();
    expect(store.enroll).toHaveBeenCalledWith(ENTITY, expect.objectContaining({ bitrixId: '9001' }), '77', [5, 6]);
    expect(store.markProcessed).toHaveBeenCalled();
  });

  it('leaves an object outside the cohort untouched unless ERP already owns it', async () => {
    const outside = setup({ policy: { cohort: new Set(['99']) } });
    await outside.worker.runDue(guard);
    expect(outside.bitrix.getCrmItem).not.toHaveBeenCalled();
    expect(outside.store.markProcessed).toHaveBeenCalledWith(ENTITY, expect.objectContaining({ assignedById: null }));

    const owned = setup({ policy: { cohort: new Set(['99']) }, ensured: remote({ managed: true, sentAssignedById: '77' }), remoteAssignedById: 77 });
    await owned.worker.runDue(guard);
    // Release: the previous manager must lose the access.
    expect(owned.bitrix.updateCrmItem).toHaveBeenCalledWith(2, '9001', { assignedById: 1 });
    expect(owned.store.beginOp).toHaveBeenCalledWith(ENTITY, expect.anything(), expect.objectContaining({ purpose: 'release', target: '1' }));
  });

  it('releases an owned object whose manager lost the mapping; without a release user it waits', async () => {
    const { worker, store, bitrix } = setup({ desired: null, ensured: remote({ managed: true, sentAssignedById: '77' }), remoteAssignedById: 77 });
    await worker.runDue(guard);
    expect(bitrix.updateCrmItem).toHaveBeenCalledWith(2, '9001', { assignedById: 1 });

    const none = setup({ desired: null, settings: { releaseAssignedById: null }, ensured: remote({ managed: true }) });
    await none.worker.runDue(guard);
    expect(none.bitrix.updateCrmItem).not.toHaveBeenCalled();
    expect(none.store.defer).toHaveBeenCalledWith(ENTITY, expect.any(Date), expect.objectContaining({ code: 'NO_RELEASE_TARGET' }));
  });

  it('does not release or restore while the configured release user differs from the channel’s', async () => {
    const release = setup({
      desired: null,
      ensured: remote({ managed: true, sentAssignedById: '77' }),
      remoteAssignedById: 77,
      policy: { releaseAssignedById: '2' },
    });
    await release.worker.runDue(guard);
    expect(release.bitrix.updateCrmItem).not.toHaveBeenCalled();
    expect(release.store.defer).toHaveBeenCalledWith(ENTITY, expect.any(Date), expect.objectContaining({ code: 'RELEASE_TARGET_MISMATCH' }));

    const restore = setup({ settings: { mode: 'restore', generation: 4 }, policy: { releaseAssignedById: '2' } });
    await restore.worker.runDue(guard);
    expect(restore.bitrix.updateCrmItem).not.toHaveBeenCalled();
    expect(restore.store.markProcessed).not.toHaveBeenCalled();
  });

  it('defers an entity whose in-flight write cannot be read back, without deciding anything else', async () => {
    const inFlight = remote({ opId: 'op-0', opTarget: '77', opEntityVersion: 2, opPurpose: 'assign', opGeneration: 1 });
    const { worker, store, bitrix } = setup({ remotes: [inFlight], remoteAssignedById: new Error('timeout') });
    await worker.runDue(guard);
    expect(store.finalize).not.toHaveBeenCalled();
    expect(store.clearOp).not.toHaveBeenCalled();
    expect(bitrix.updateCrmItem).not.toHaveBeenCalled();
    expect(store.defer).toHaveBeenCalledWith(ENTITY, expect.any(Date), expect.objectContaining({ code: 'RECOVERY_READ_FAILED', countAttempt: true }));
  });

  it('waits for the CRM object instead of finishing the entity', async () => {
    const { worker, store, bitrix } = setup({ current: null });
    await worker.runDue(guard);
    expect(bitrix.getCrmItem).not.toHaveBeenCalled();
    expect(store.markProcessed).not.toHaveBeenCalled();
    expect(store.defer).toHaveBeenCalledWith(ENTITY, expect.any(Date), expect.objectContaining({ code: 'WAITING_FOR_MAPPING', countAttempt: false }));
  });

  it('keeps the operation when the write fails (the outcome may be unknown)', async () => {
    const { worker, store } = setup({ updateError: new Error('socket hang up') });
    await worker.runDue(guard);
    expect(store.finalize).not.toHaveBeenCalled();
    expect(store.clearOp).not.toHaveBeenCalled();
    expect(store.defer).toHaveBeenCalledWith(ENTITY, expect.any(Date), expect.objectContaining({ code: 'WRITE_FAILED', countAttempt: true }));
  });

  it('confirms an in-flight write found on a claim when Bitrix24 shows its target, without writing again', async () => {
    const inFlight = remote({ opId: 'op-0', opTarget: '77', opEntityVersion: 2, opPurpose: 'assign', opGeneration: 1 });
    const { worker, store, bitrix } = setup({ remotes: [inFlight], remoteAssignedById: 77, ensured: remote({ managed: true, sentAssignedById: '77' }) });
    await worker.runDue(guard);
    expect(store.finalize).toHaveBeenCalledWith({ remote: inFlight, opId: 'op-0' });
    expect(bitrix.updateCrmItem).not.toHaveBeenCalled();
  });

  it('forgets an in-flight write that did not take effect, even when the CRM mapping is gone', async () => {
    const inFlight = remote({ opId: 'op-0', opTarget: '77', opEntityVersion: 2, opPurpose: 'assign', opGeneration: 1 });
    const { worker, store } = setup({ remotes: [inFlight], remoteAssignedById: 5, current: null });
    await worker.runDue(guard);
    expect(store.clearOp).toHaveBeenCalledWith(inFlight, 'op-0', '5', false);
    expect(store.defer).toHaveBeenCalledWith(ENTITY, expect.any(Date), expect.objectContaining({ code: 'WAITING_FOR_MAPPING' }));

    const deleted = setup({
      remotes: [inFlight],
      remoteAssignedById: new Bitrix24ApiError('crm.item.get', 'NOT_FOUND', 'Not found', 400),
      current: null,
    });
    await deleted.worker.runDue(guard);
    expect(deleted.store.clearOp).toHaveBeenCalledWith(inFlight, 'op-0', null, true);
  });

  describe('restore', () => {
    const settings = { mode: 'restore' as const, generation: 4 };
    const target = (overrides: Partial<AssignmentRemote>) =>
      remote({ managed: true, sentAssignedById: '77', restoreGeneration: 4, restoreOutcome: 'pending', restoreTarget: '1', ...overrides });

    it('writes the restore target over ERP’s own last write', async () => {
      const row = target({});
      const { worker, store, bitrix } = setup({ settings, remotes: [row], remoteAssignedById: 77 });
      await worker.runDue(guard);
      expect(store.currentObject).not.toHaveBeenCalled();
      expect(bitrix.updateCrmItem).toHaveBeenCalledWith(2, '9001', { assignedById: 1 });
      expect(store.beginOp).toHaveBeenCalledWith(ENTITY, row, expect.objectContaining({ purpose: 'restore', target: '1', generation: 4, current: '77' }));
      expect(store.markProcessed).toHaveBeenCalled();
    });

    it('carries the restore command’s causes with every target, also after they were closed', async () => {
      const row = target({ restoreCauseIds: [40] });
      const { worker, store } = setup({ settings, remotes: [row], remoteAssignedById: 77 });
      await worker.runDue(guard);
      expect(store.beginOp).toHaveBeenCalledWith(ENTITY, row, expect.objectContaining({ causeIds: [2, 3, 40] }));
    });

    it('preserves a hand-made change and classifies restored and missing objects', async () => {
      const conflict = setup({ settings, remotes: [target({})], remoteAssignedById: 33 });
      await conflict.worker.runDue(guard);
      expect(conflict.bitrix.updateCrmItem).not.toHaveBeenCalled();
      expect(conflict.store.setRestoreOutcome).toHaveBeenCalledWith(expect.anything(), 4, 'conflict_preserved', '33');

      const already = setup({ settings, remotes: [target({})], remoteAssignedById: 1 });
      await already.worker.runDue(guard);
      expect(already.store.setRestoreOutcome).toHaveBeenCalledWith(expect.anything(), 4, 'restored', '1');

      const missing = setup({
        settings,
        remotes: [target({})],
        remoteAssignedById: new Bitrix24ApiError('crm.item.get', 'NOT_FOUND', 'Not found', 400),
      });
      await missing.worker.runDue(guard);
      expect(missing.store.setRestoreOutcome).toHaveBeenCalledWith(expect.anything(), 4, 'missing', null);
    });

    it('does not finish the entity while a target read fails', async () => {
      const { worker, store } = setup({ settings, remotes: [target({})], remoteAssignedById: new Error('timeout') });
      await worker.runDue(guard);
      expect(store.markProcessed).not.toHaveBeenCalled();
      expect(store.defer).toHaveBeenCalledWith(ENTITY, expect.any(Date), expect.objectContaining({ code: 'READ_FAILED' }));
    });
  });

  it('stops the batch when the relay loses its writer lock', async () => {
    const lost = Object.assign(new Error('ownership lost'), { name: 'OwnershipLost' });
    const { worker, store, bitrix } = setup();
    store.claimDue.mockResolvedValue([ENTITY, { ...ENTITY, erpId: '502' }]);
    bitrix.withRequestGuard.mockRejectedValueOnce(lost);
    expect(await worker.runDue(guard)).toEqual({ processed: 0 });
    expect(store.release).toHaveBeenCalledTimes(1);
    expect(bitrix.withRequestGuard).toHaveBeenCalledTimes(1);
  });
});

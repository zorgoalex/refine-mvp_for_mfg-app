import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { BroadcastWorker, toImages } from './broadcast-worker.service';
import { BroadcastService } from './broadcast.service';

const snapshot = (date: string, ids: number[]) => ({
  businessDate: date, rendererVersion: 'v', cardsPerMessage: 2, totalArea: 1,
  orders: ids.map((orderId) => ({ orderId })), workflowDisplay: { displayOrderCodes: [], codeToLetter: {}, codeToName: {} },
});

function makeWorker(overrides: Record<string, unknown> = {}) {
  const repository = {
    listActiveBroadcastIds: vi.fn().mockResolvedValue([1, 2, 3]),
    fixAutomaticRun: vi.fn().mockResolvedValue('fixed'),
    listPreparingRuns: vi.fn().mockResolvedValue(['run-1']),
    getPreparationContext: vi.fn().mockResolvedValue({ runId: 'run-1', broadcastId: 1, businessDate: '2026-10-05', targetDate: '2026-10-06',
      scheduleGeneration: 1, settingsVersion: 1, cardsPerMessage: 2, captionTemplate: 'Заказы на {target_date}', deadlineAt: new Date(Date.now() + 60_000), scheduledAt: new Date() }),
    completePreparation: vi.fn().mockResolvedValue('queued'),
    failPreparation: vi.fn(),
    markStaleIntentsUnknown: vi.fn(),
    listDeliverableRuns: vi.fn().mockResolvedValue([]),
    expireAndPrune: vi.fn().mockResolvedValue({ referenced: new Map(), expiredKeys: [], prunedRuns: 0 }),
    legacyQueueUnfinished: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
  const files = [{ fileKey: 'f1', sha256: 'a'.repeat(64), sizeBytes: 1, expiresAt: new Date() }];
  const store = {
    withStoreLock: vi.fn(async (handler: (owned: () => Promise<void>) => unknown) => handler(async () => undefined)),
    writePages: vi.fn().mockResolvedValue(files), remove: vi.fn().mockResolvedValue(undefined), sweep: vi.fn().mockResolvedValue({}),
  };
  const database = { withAdvisoryLock: vi.fn(async (_name: string, handler: (owned: () => Promise<void>) => unknown) => handler(async () => undefined)) };
  const runtime = { getConfig: () => ({ enabled: true, relayOwner: 'in_process', relayStaleLockMs: 60_000 }) };
  const reader = { read: vi.fn(async (date: string) => snapshot(date, [5])) };
  const renderer = { render: vi.fn(async () => [{ pageIndex: 1, orderIds: [5], png: Buffer.from('png') }]) };
  const legacyRepository = { expireImagesAndPruneSnapshots: vi.fn().mockResolvedValue({ referenced: new Map(), expiredKeys: [], prunedRuns: 0 }) };
  const logs = { record: vi.fn().mockResolvedValue(undefined) };
  const worker = new BroadcastWorker(repository as never, store as never, database as never, runtime as never, {} as never, reader as never,
    renderer as never, legacyRepository as never, store as never, logs as never);
  return { worker, repository, store, reader, renderer, logs, database };
}

describe('BroadcastWorker', () => {
  it('keeps fixing the other broadcasts when one fails and logs the failure', async () => {
    const { worker, repository, logs } = makeWorker();
    repository.fixAutomaticRun.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'x'));
    await worker.fixDue(() => new Date('2026-10-05T03:50:00Z'));
    expect(repository.fixAutomaticRun).toHaveBeenCalledTimes(3);
    expect(logs.record).toHaveBeenCalledWith(expect.objectContaining({ eventCode: 'whatsapp.broadcast.fixation', errorCode: 'INTERNAL_ERROR' }));
  });

  it('prepares the target date with the rendered caption on the first image only', async () => {
    const { worker, repository, reader } = makeWorker();
    await worker.cleanup();
    await worker.prepareDue(new Date());
    expect(reader.read).toHaveBeenCalledWith('2026-10-06');
    const [, input] = repository.completePreparation.mock.calls[0];
    expect(input.images).toEqual([expect.objectContaining({ imageIndex: 1, caption: 'Заказы на 06.10.2026' })]);
  });

  it('deletes the written files when the preparation turned out to be stale', async () => {
    const { worker, repository, store } = makeWorker();
    repository.completePreparation.mockResolvedValueOnce('superseded');
    await worker.prepareDue();
    expect(store.remove).toHaveBeenCalledWith('f1', expect.any(Function));
  });

  it('fails a preparation past its deadline without rendering', async () => {
    const { worker, repository, renderer } = makeWorker();
    repository.getPreparationContext.mockResolvedValueOnce({ runId: 'run-1', broadcastId: 1, targetDate: '2026-10-06', deadlineAt: new Date(Date.now() - 1), cardsPerMessage: 2, captionTemplate: '' });
    await worker.prepareDue();
    expect(repository.failPreparation).toHaveBeenCalledWith('run-1', 'BROADCAST_PREPARATION_LATE');
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('does not deliver or prepare until the image store cleanup succeeded', async () => {
    const { worker, repository } = makeWorker();
    await worker.work();
    expect(repository.listDeliverableRuns).not.toHaveBeenCalled();
    expect(repository.listPreparingRuns).not.toHaveBeenCalled();
    await worker.cleanup();
    await worker.work();
    expect(repository.listDeliverableRuns).toHaveBeenCalled();
    expect(repository.listPreparingRuns).toHaveBeenCalled();
    expect(repository.listDeliverableRuns.mock.invocationCallOrder[0]).toBeLessThan(repository.listPreparingRuns.mock.invocationCallOrder[0]);
  });

  it('keeps fixing slots while a delivery iteration hangs (separate busy flags)', async () => {
    let release!: () => void;
    const { worker, repository } = makeWorker({ listDeliverableRuns: vi.fn(() => new Promise<string[]>((resolve) => { release = () => resolve([]); })) });
    await worker.cleanup();
    const hanging = worker.work();
    await vi.waitFor(() => expect(repository.listDeliverableRuns).toHaveBeenCalled());
    await worker.fixDue(() => new Date());
    expect(repository.fixAutomaticRun).toHaveBeenCalledTimes(3);
    release();
    await hanging;
  });

  it('maps rendered pages to stored images', () => {
    const images = toImages([{ pageIndex: 1, orderIds: [1, 2], png: Buffer.from('') }, { pageIndex: 2, orderIds: [3], png: Buffer.from('') }],
      [{ fileKey: 'a', sha256: 's', sizeBytes: 1, expiresAt: new Date(0) }, { fileKey: 'b', sha256: 't', sizeBytes: 2, expiresAt: new Date(0) }], '');
    expect(images.map((image) => [image.imageIndex, image.fileKey, image.caption])).toEqual([[1, 'a', null], [2, 'b', null]]);
  });
});

describe('BroadcastService retry', () => {
  it('replays a committed retry from the ledger even when WhatsApp is unavailable now', async () => {
    const repository = { runBroadcastId: vi.fn().mockResolvedValue(3), findCommand: vi.fn().mockResolvedValue({ runId: 'run-r' }),
      getRunDetail: vi.fn().mockResolvedValue({ run: { id: 'run-r' }, messages: [] }), createRetry: vi.fn() };
    const worker = { runtime: () => ({ relayAvailable: false }) };
    const service = new BroadcastService(repository as never, worker as never, {} as never, {} as never);
    const result = await service.retry('0f8fad5b-d9cb-469f-a165-70867728950e', { mode: 'remaining', idempotencyKey: '1f8fad5b-d9cb-469f-a165-70867728950e', duplicateRiskConfirmed: false },
      { id: '11', username: 'u', role: 'admin', roleId: 1, permissions: [] }, 'req');
    expect(result.run.id).toBe('run-r');
    expect(repository.createRetry).not.toHaveBeenCalled();
  });

  it('refuses a new retry while WhatsApp is unavailable', async () => {
    const repository = { runBroadcastId: vi.fn().mockResolvedValue(3), findCommand: vi.fn().mockResolvedValue(null), createRetry: vi.fn() };
    const service = new BroadcastService(repository as never, { runtime: () => ({ relayAvailable: false }) } as never, {} as never, {} as never);
    await expect(service.retry('0f8fad5b-d9cb-469f-a165-70867728950e', { mode: 'remaining', idempotencyKey: '1f8fad5b-d9cb-469f-a165-70867728950e', duplicateRiskConfirmed: false },
      { id: '11', username: 'u', role: 'admin', roleId: 1, permissions: [] }, 'req')).rejects.toMatchObject({ code: 'BROADCAST_RUNTIME_UNAVAILABLE' });
    expect(repository.createRetry).not.toHaveBeenCalled();
  });
});

describe('BroadcastService manual send', () => {
  it('replays a key committed after the fast lookup even though the version changed since (no 409 for a committed key)', async () => {
    // Order: fast lookup misses -> the first attempt commits -> someone saves settings (version 3 -> 4) -> this attempt.
    const repository = {
      findCommand: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ runId: 'run-first' }),
      getBroadcast: vi.fn().mockResolvedValue({ id: 4, version: 4, archived: false, groupChatId: 'g@g.us', orderDateOffsetDays: 0 }),
      getRunDetail: vi.fn().mockResolvedValue({ run: { id: 'run-first' }, messages: [] }),
      createManualRun: vi.fn(),
    };
    const worker = { storeReady: true, runtime: () => ({ relayAvailable: true }),
      withRenderLease: vi.fn(async (handler: (owned: () => Promise<void>) => unknown) => handler(async () => undefined)) };
    const service = new BroadcastService(repository as never, worker as never, {} as never, {} as never);
    const result = await service.createManual(4, { settingsVersion: 3, idempotencyKey: '0f8fad5b-d9cb-469f-a165-70867728950e', confirmed: true },
      { id: '11', username: 'u', role: 'admin', roleId: 1, permissions: [] }, 'req');
    expect(result.run.id).toBe('run-first');
    expect(repository.getBroadcast).not.toHaveBeenCalled();
    expect(repository.createManualRun).not.toHaveBeenCalled();
  });

  it('refuses a stale version only under the render lease, after the second ledger lookup', async () => {
    const order: string[] = [];
    const repository = {
      findCommand: vi.fn(async () => { order.push('ledger'); return null; }),
      getBroadcast: vi.fn(async () => { order.push('settings'); return { id: 4, version: 4, archived: false, groupChatId: 'g@g.us', orderDateOffsetDays: 0 }; }),
    };
    const worker = { storeReady: true, runtime: () => ({ relayAvailable: true }),
      withRenderLease: vi.fn(async (handler: (owned: () => Promise<void>) => unknown) => { order.push('lease'); return handler(async () => undefined); }) };
    const service = new BroadcastService(repository as never, worker as never, {} as never, {} as never);
    await expect(service.createManual(4, { settingsVersion: 3, idempotencyKey: '0f8fad5b-d9cb-469f-a165-70867728950e', confirmed: true },
      { id: '11', username: 'u', role: 'admin', roleId: 1, permissions: [] }, 'req')).rejects.toMatchObject({ code: 'BROADCAST_VERSION_CONFLICT' });
    expect(order).toEqual(['ledger', 'lease', 'ledger', 'settings']);
  });

  it('replays a committed command without rendering', async () => {
    const repository = { findCommand: vi.fn().mockResolvedValue({ runId: 'run-9' }), getRunDetail: vi.fn().mockResolvedValue({ run: { id: 'run-9' }, messages: [] }) };
    const worker = { withRenderLease: vi.fn(), storeReady: true, runtime: () => ({ relayAvailable: true }) };
    const service = new BroadcastService(repository as never, worker as never, {} as never, {} as never);
    const result = await service.createManual(4, { settingsVersion: 2, idempotencyKey: '0f8fad5b-d9cb-469f-a165-70867728950e', confirmed: true },
      { id: '11', username: 'u', role: 'admin', roleId: 1, permissions: [] }, 'req');
    expect(result.run.id).toBe('run-9');
    expect(worker.withRenderLease).not.toHaveBeenCalled();
  });
});

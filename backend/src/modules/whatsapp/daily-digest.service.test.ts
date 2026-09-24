import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import { DailyDigestService, automaticDeadline, automaticWindowState, businessDate, businessTime, scheduleTiming } from './daily-digest.service';
import type { DailyDigestSchedule, DailyDigestSettings } from './daily-digest.types';

const settings: DailyDigestSettings = {
  version: 1, enabled: true, groupChatId: 'example@g.us', sendTime: '08:45', sendWindowMinutes: 0, timeZone: 'Asia/Almaty', cardsPerMessage: 2,
  catchUpPolicy: 'skip', catchUpDeadline: '10:00', partialPolicy: 'remaining',
};

const scheduleFor = (date: string, chosenAlmatyTime: string, overrides: Partial<DailyDigestSchedule> = {}): DailyDigestSchedule => ({
  businessDate: date,
  scheduledAt: new Date(`${date}T${chosenAlmatyTime}:00.000+05:00`).toISOString(),
  windowStart: '08:45', windowEnd: '08:45', sendWindowMinutes: 0,
  catchUpPolicy: 'skip', catchUpDeadline: '10:00', settingsVersion: 1,
  createdAt: `${date}T00:00:00.000Z`, ...overrides,
});

describe('daily digest scheduling boundaries', () => {
  it('includes all seconds in the scheduled minute and closes immediately after it', () => {
    expect(automaticWindowState(settings, new Date('2026-09-23T03:45:00.000Z'))).toBe('open');
    expect(automaticWindowState(settings, new Date('2026-09-23T03:45:59.999Z'))).toBe('open');
    expect(automaticWindowState(settings, new Date('2026-09-23T03:46:00.000Z'))).toBe('missed');
    expect(automaticWindowState(settings, new Date('2026-09-23T03:44:59.999Z'))).toBe('before');
  });

  it('keeps until-deadline and end-of-day open through the configured final second', () => {
    expect(automaticWindowState({ ...settings, catchUpPolicy: 'until_deadline' }, new Date('2026-09-23T05:00:59.999Z'))).toBe('open');
    expect(automaticWindowState({ ...settings, catchUpPolicy: 'until_deadline' }, new Date('2026-09-23T05:01:00.000Z'))).toBe('missed');
    expect(automaticWindowState({ ...settings, catchUpPolicy: 'end_of_day' }, new Date('2026-09-23T18:59:59.999Z'))).toBe('open');
    // Once Almaty crosses midnight, the current business day has not opened yet.
    expect(automaticWindowState({ ...settings, catchUpPolicy: 'end_of_day' }, new Date('2026-09-23T19:00:00.000Z'))).toBe('before');
    expect(automaticDeadline(settings, '2026-09-23').toISOString()).toBe('2026-09-23T03:45:59.999Z');
  });
});

describe('daily digest private image startup gate', () => {
  function makeService(options: { lockResult?: null | undefined } = {}) {
    const repository = { expireImagesAndPruneSnapshots: vi.fn().mockResolvedValue({ referenced: new Map(), expiredKeys: [] }), getPageImageMetadata: vi.fn(), getSettings: vi.fn().mockResolvedValue({ ...settings }), getOrCreateSchedule: vi.fn().mockResolvedValue(null), createRun: vi.fn() };
    const store = {
      withStoreLock: vi.fn(async (handler: (assertOwned: () => Promise<void>) => Promise<unknown>) => {
        if (options.lockResult === null) return null;
        return handler(async () => undefined);
      }),
      sweep: vi.fn().mockResolvedValue({ expired: [], orphaned: [] }),
      readImage: vi.fn(),
    };
    const database = { withAdvisoryLock: vi.fn(async (_name: string, handler: (assertOwned: () => Promise<void>) => Promise<unknown>) => handler(async () => undefined)) };
    const date = businessDate();
    const reader = { read: vi.fn().mockResolvedValue({ businessDate: date, rendererVersion: 'test-v1', cardsPerMessage: 2, totalArea: 0, orders: [], workflowDisplay: { displayOrderCodes: [], codeToLetter: {}, codeToName: {} } }) };
    const renderer = { render: vi.fn() };
    const service = new DailyDigestService(repository as never, store as never, database as never, {} as never, {} as never, reader as never, renderer as never);
    return { service, repository, store, reader, renderer };
  }

  it('keeps ERP startup available if the shared cleanup lock is unavailable', async () => {
    const { service } = makeService({ lockResult: null });
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('does not expose stored image reads until startup cleanup succeeds', async () => {
    const { service, repository } = makeService({ lockResult: null });
    await expect(service.image('run-id', 1)).rejects.toBeInstanceOf(ApiError);
    expect(repository.getPageImageMetadata).not.toHaveBeenCalled();
  });

  it('runs cleanup under the shared store lock and then permits image lookup', async () => {
    const { service, repository, store } = makeService();
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(repository.expireImagesAndPruneSnapshots).toHaveBeenCalledOnce();
    expect(store.sweep).toHaveBeenCalledOnce();
    repository.getPageImageMetadata.mockResolvedValue({ fileKey: 'x', sha256: 'y', expiresAt: new Date(Date.now() + 1000) });
    store.readImage.mockResolvedValue({ bytes: Buffer.from('png'), expiresAt: new Date(Date.now() + 1000) });
    await expect(service.image('run-id', 1)).resolves.toMatchObject({ bytes: Buffer.from('png') });
  });

  it('does not start background sends before cleanup succeeds, while in-memory preview remains available', async () => {
    const { service, repository, reader, renderer } = makeService({ lockResult: null });
    await service.onModuleInit();
    await service.tick();
    // Planning is intentionally DB-only; send-path work stays gated on the store.
    expect(repository.getOrCreateSchedule).toHaveBeenCalledOnce();
    expect(reader.read).not.toHaveBeenCalled();
    await expect(service.preview()).resolves.toMatchObject({ empty: true, pages: [] });
    expect(reader.read).toHaveBeenCalledOnce();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('renders one card per message when the saved preview setting is one',async()=>{
    const {service,repository,reader,renderer}=makeService();
    repository.getSettings.mockResolvedValue({...settings,cardsPerMessage:1});
    const orders=[{orderId:11},{orderId:12}];
    reader.read.mockResolvedValue({businessDate:businessDate(),rendererVersion:'test-v1',cardsPerMessage:2,totalArea:3,orders,workflowDisplay:{displayOrderCodes:[],codeToLetter:{},codeToName:{}}});
    renderer.render.mockImplementation(async(snapshot:{cardsPerMessage:number;orders:Array<{orderId:number}>})=>snapshot.orders.map((order,index)=>({pageIndex:index+1,orderIds:[order.orderId],png:Buffer.from('png')})));
    const preview=await service.preview();
    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({cardsPerMessage:1}));
    expect(preview.pages.map(page=>page.orderIds)).toEqual([[11],[12]]);
  });

  it('rejects a 501st order before invoking the renderer',async()=>{
    const {service,reader,renderer}=makeService();
    reader.read.mockResolvedValue({businessDate:businessDate(),rendererVersion:'test-v1',cardsPerMessage:2,totalArea:0,
      orders:Array.from({length:501},(_,index)=>({orderId:index+1})),workflowDisplay:{displayOrderCodes:[],codeToLetter:{},codeToName:{}}});
    await expect(service.preview()).rejects.toMatchObject({code:'WHATSAPP_DAILY_DIGEST_SNAPSHOT_INVALID'});
    expect(renderer.render).not.toHaveBeenCalled();
  });
});

describe('daily digest ambiguous persistence cleanup', () => {
  it('rechecks idempotency after acquiring the render lease before reading, rendering or writing', async () => {
    const winner = { run: { id: 'already-committed' }, pages: [] };
    let lookup = 0;
    const repository = {
      findByIdempotency: vi.fn().mockImplementation(async () => ++lookup === 1 ? null : winner),
      getSettings: vi.fn().mockResolvedValue({ ...settings, version: 5 }),
      expireImagesAndPruneSnapshots: vi.fn().mockResolvedValue({ referenced: new Map(), expiredKeys: [] }),
      createRun: vi.fn(),
    };
    const store = {
      withStoreLock: vi.fn(async (handler: (assertOwned: () => Promise<void>) => Promise<unknown>) => handler(async () => undefined)),
      writePages: vi.fn(), remove: vi.fn(), sweep: vi.fn().mockResolvedValue({ expired: [], orphaned: [] }),
    };
    const database = { withAdvisoryLock: vi.fn(async (_name: string, handler: (assertOwned: () => Promise<void>) => Promise<unknown>) => handler(async () => undefined)) };
    const reader = { read: vi.fn() };
    const renderer = { render: vi.fn() };
    const runtime = { getConfig: () => ({ enabled: false, relayOwner: 'external' }) };
    const service = new DailyDigestService(repository as never, store as never, database as never, runtime as never, {} as never, reader as never, renderer as never);

    await service.onModuleInit();
    await expect(service.createManual({ settingsVersion: 4, idempotencyKey: 'same-key', confirmed: true }, { id: 'actor-1' } as never, 'request-2'))
      .resolves.toEqual(winner);
    expect(repository.findByIdempotency).toHaveBeenCalledTimes(2);
    expect(repository.getSettings).not.toHaveBeenCalled();
    expect(reader.read).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
    expect(store.writePages).not.toHaveBeenCalled();
    expect(repository.createRun).not.toHaveBeenCalled();
  });

  it('keeps page files when commit may have succeeded and returns the committed run on idempotent retry', async () => {
    const date = businessDate();
    const snapshot = {
      businessDate: date,
      rendererVersion: 'test-v1',
      cardsPerMessage: 2,
      totalArea: 12,
      orders: [{ orderId: 71 }],
      workflowDisplay: { displayOrderCodes: [], codeToLetter: {}, codeToName: {} },
    };
    const committedRun = { run: { id: 'committed-run' }, pages: [] };
    let commitMayHaveSucceeded = false;
    const repository = {
      findByIdempotency: vi.fn().mockImplementation(async () => commitMayHaveSucceeded ? committedRun : null),
      getSettings: vi.fn().mockResolvedValue({ ...settings, version: 4 }),
      expireImagesAndPruneSnapshots: vi.fn().mockResolvedValue({ referenced: new Map(), expiredKeys: [] }),
      createRun: vi.fn().mockImplementation(async () => {
        commitMayHaveSucceeded = true;
        throw new Error('connection dropped after commit');
      }),
    };
    const store = {
      withStoreLock: vi.fn(async (handler: (assertOwned: () => Promise<void>) => Promise<unknown>) => handler(async () => undefined)),
      writePages: vi.fn().mockResolvedValue([{ fileKey: 'owned.png', sha256: 'hash', sizeBytes: 3, expiresAt: new Date(Date.now() + 86_400_000) }]),
      remove: vi.fn().mockResolvedValue(undefined),
      sweep: vi.fn().mockResolvedValue({ expired: [], orphaned: [] }),
    };
    const database = { withAdvisoryLock: vi.fn(async (_name: string, handler: (assertOwned: () => Promise<void>) => Promise<unknown>) => handler(async () => undefined)) };
    const reader = { read: vi.fn().mockResolvedValue(snapshot) };
    const renderer = { render: vi.fn().mockResolvedValue([{ pageIndex: 1, orderIds: [71], png: Buffer.from('png') }]) };
    const runtime = { getConfig: () => ({ enabled: true, relayOwner: 'in_process' }) };
    const service = new DailyDigestService(repository as never, store as never, database as never, runtime as never, {} as never, reader as never, renderer as never);
    const actor = { id: 'actor-1' } as never;
    const input = { settingsVersion: 4, idempotencyKey: 'idempotency-1', confirmed: true as const };

    await service.onModuleInit();
    await expect(service.createManual(input, actor, 'request-1')).rejects.toThrow('connection dropped after commit');
    expect(repository.createRun.mock.calls[0][0].snapshot.cardsPerMessage).toBe(2);
    expect(store.remove).not.toHaveBeenCalled();
    await expect(service.createManual(input, actor, 'request-2')).resolves.toEqual(committedRun);
    expect(repository.createRun).toHaveBeenCalledOnce();
    expect(store.writePages).toHaveBeenCalledOnce();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('does not delete automatic run files after an ambiguous commit failure', async () => {
    const date = '2026-09-23';
    const snapshot = {
      businessDate: date, rendererVersion: 'test-v1', cardsPerMessage: 2, totalArea: 12, orders: [{ orderId: 71 }],
      workflowDisplay: { displayOrderCodes: [], codeToLetter: {}, codeToName: {} },
    };
    let commitMayHaveSucceeded = false;
    const repository = {
      getSettings: vi.fn().mockResolvedValue({ ...settings, cardsPerMessage: 1 }),
      expireImagesAndPruneSnapshots: vi.fn().mockResolvedValue({ referenced: new Map(), expiredKeys: [] }),
      getOrCreateSchedule: vi.fn().mockResolvedValue(scheduleFor(date, '08:45')),
      hasAutomaticRun: vi.fn().mockImplementation(async () => commitMayHaveSucceeded),
      createRun: vi.fn().mockImplementation(async () => {
        commitMayHaveSucceeded = true;
        throw new Error('connection dropped after commit');
      }),
      markStaleIntentsUnknown: vi.fn().mockResolvedValue(undefined),
      listQueuedRunIds: vi.fn().mockResolvedValue([]),
    };
    const store = {
      withStoreLock: vi.fn(async (handler: (assertOwned: () => Promise<void>) => Promise<unknown>) => handler(async () => undefined)),
      writePages: vi.fn().mockResolvedValue([{ fileKey: 'auto-owned.png', sha256: 'hash', sizeBytes: 3, expiresAt: new Date(Date.now() + 86_400_000) }]),
      remove: vi.fn().mockResolvedValue(undefined),
      sweep: vi.fn().mockResolvedValue({ expired: [], orphaned: [] }),
    };
    const database = { withAdvisoryLock: vi.fn(async (_name: string, handler: (assertOwned: () => Promise<void>) => Promise<unknown>) => handler(async () => undefined)) };
    const reader = { read: vi.fn().mockResolvedValue(snapshot) };
    const renderer = { render: vi.fn().mockResolvedValue([{ pageIndex: 1, orderIds: [71], png: Buffer.from('png') }]) };
    const runtime = { getConfig: () => ({ enabled: true, relayOwner: 'in_process', relayStaleLockMs: 60_000 }) };
    const service = new DailyDigestService(repository as never, store as never, database as never, runtime as never, {} as never, reader as never, renderer as never);
    const scheduledAt = new Date('2026-09-23T03:45:30.000Z');

    await service.onModuleInit();
    await service.tick(scheduledAt);
    expect(repository.createRun).toHaveBeenCalledOnce();
    expect(repository.createRun.mock.calls[0][0].snapshot.cardsPerMessage).toBe(1);
    expect(store.remove).not.toHaveBeenCalled();
    await service.tick(scheduledAt);
    expect(repository.hasAutomaticRun).toHaveBeenCalledTimes(2);
    expect(store.writePages).toHaveBeenCalledOnce();
    expect(store.remove).not.toHaveBeenCalled();
  });
});

describe('daily digest delivery ordering', () => {
  function makeDeliveryService(pageStates: Array<{ page_index: number; state: string }>) {
    const future = new Date(Date.now() + 60_000);
    const repository = {
      expireImagesAndPruneSnapshots: vi.fn().mockResolvedValue({ referenced: new Map(), expiredKeys: [] }),
      getSettings: vi.fn().mockResolvedValue({ ...settings, enabled: false }),
      getOrCreateSchedule: vi.fn().mockResolvedValue(scheduleFor('2026-09-23', '08:45')),
      getSchedule: vi.fn().mockResolvedValue(null),
      hasAutomaticRun: vi.fn().mockResolvedValue(true),
      listRuns: vi.fn(),
      markStaleIntentsUnknown: vi.fn().mockResolvedValue(undefined),
      listQueuedRunIds: vi.fn().mockResolvedValue(['run-1']),
      pagesForWorker: vi.fn().mockResolvedValue(pageStates),
      getPageImageMetadata: vi.fn().mockImplementation(async (_runId: string, pageIndex: number) => ({ fileKey: `${pageIndex}.png`, sha256: 'digest', expiresAt: future })),
      createSendIntent: vi.fn().mockImplementation(async (_runId: string, pageIndex: number) => ({ token: `token-${pageIndex}`, destinationChatId: 'example@g.us' })),
      settlePage: vi.fn().mockResolvedValue(true),
      markRun: vi.fn().mockResolvedValue(undefined),
      failPendingPageBeforeIntent: vi.fn().mockResolvedValue(undefined),
      createPolicyRetryAfterPreflightFailure: vi.fn().mockResolvedValue(null),
    };
    const store = {
      withStoreLock: vi.fn(async (handler: (assertOwned: () => Promise<void>) => Promise<unknown>) => handler(async () => undefined)),
      readImage: vi.fn().mockResolvedValue({ bytes: Buffer.from('png'), expiresAt: future }),
      sweep: vi.fn().mockResolvedValue({ expired: [], orphaned: [] }),
    };
    const database = { withAdvisoryLock: vi.fn(async (_name: string, handler: (assertOwned: () => Promise<void>) => Promise<unknown>) => handler(async () => undefined)) };
    const waha = { sendImage: vi.fn().mockImplementation(async (_chat: string, _bytes: Buffer, name: string) => ({ messageId: name })) };
    const runtime = { getConfig: () => ({ enabled: true, relayOwner: 'in_process', relayStaleLockMs: 60_000 }) };
    const service = new DailyDigestService(repository as never, store as never, database as never, runtime as never, waha as never, {} as never, {} as never);
    return { service, repository, waha };
  }

  it('reconciles stale intents before enumerating work and never passes a failed earlier page', async () => {
    const { service, repository, waha } = makeDeliveryService([{ page_index: 1, state: 'failed' }, { page_index: 2, state: 'pending' }]);
    await service.onModuleInit();
    await service.tick();
    expect(repository.markStaleIntentsUnknown).toHaveBeenCalledOnce();
    expect(repository.markStaleIntentsUnknown.mock.invocationCallOrder[0]).toBeLessThan(repository.listQueuedRunIds.mock.invocationCallOrder[0]);
    expect(waha.sendImage).not.toHaveBeenCalled();
  });

  it('sends pages in ascending order, continuing only after the prior page is acknowledged', async () => {
    const { service, waha } = makeDeliveryService([
      { page_index: 1, state: 'sent' }, { page_index: 2, state: 'pending' }, { page_index: 3, state: 'pending' },
    ]);
    await service.onModuleInit();
    await service.tick();
    expect(waha.sendImage.mock.calls.map(call => call[2])).toEqual(['orders-2.png', 'orders-3.png']);
  });

  it('uses the dedicated automatic-date lookup instead of latest-50 history', async () => {
    const { service, repository } = makeDeliveryService([]);
    repository.getSettings.mockResolvedValue({ ...settings, enabled: true });
    await service.onModuleInit();
    await service.tick(new Date('2026-09-23T03:45:30.000Z'));
    expect(repository.hasAutomaticRun).toHaveBeenCalledWith('2026-09-23');
    expect(repository.listRuns).not.toHaveBeenCalled();
  });

  it('still processes queued manual work when automatic scheduling throws', async () => {
    const { service, repository, waha } = makeDeliveryService([{ page_index: 1, state: 'pending' }]);
    repository.getSettings.mockRejectedValueOnce(new Error('settings unavailable'));
    await service.onModuleInit();
    await service.tick();
    expect(waha.sendImage).toHaveBeenCalledOnce();
  });
});

describe('daily digest random dispatch window', () => {
  function makeAutoService(options: { relayAvailable?: boolean; schedule?: DailyDigestSchedule | null; settingsOverride?: Partial<DailyDigestSettings>; orders?: Array<{ orderId: number }> } = {}) {
    const emptySnapshot = {
      businessDate: '2026-09-23', rendererVersion: 'test-v1', cardsPerMessage: 2, totalArea: 0,
      orders: options.orders ?? [], workflowDisplay: { displayOrderCodes: [], codeToLetter: {}, codeToName: {} },
    };
    const repository = {
      expireImagesAndPruneSnapshots: vi.fn().mockResolvedValue({ referenced: new Map(), expiredKeys: [] }),
      getSettings: vi.fn().mockResolvedValue({ ...settings, ...(options.settingsOverride ?? {}) }),
      updateSettings: vi.fn().mockImplementation(async () => ({ ...settings, ...(options.settingsOverride ?? {}), version: 9 })),
      getOrCreateSchedule: vi.fn().mockResolvedValue(options.schedule === undefined ? scheduleFor('2026-09-23', '08:45') : options.schedule),
      getSchedule: vi.fn().mockResolvedValue(options.schedule ?? null),
      hasAutomaticRun: vi.fn().mockResolvedValue(false),
      createRun: vi.fn().mockResolvedValue({ run: { id: 'run-auto' }, pages: [] }),
      markStaleIntentsUnknown: vi.fn().mockResolvedValue(undefined),
      listQueuedRunIds: vi.fn().mockResolvedValue([]),
    };
    const store = {
      withStoreLock: vi.fn(async (handler: (assertOwned: () => Promise<void>) => Promise<unknown>) => handler(async () => undefined)),
      writePages: vi.fn().mockImplementation(async (pages: Array<{ pageIndex: number }>) => pages.map(() => ({ fileKey: `${randomUUID()}-p.png`, sha256: 'a'.repeat(64), sizeBytes: 128, expiresAt: new Date(Date.now() + 86_400_000) }))), remove: vi.fn(),
      sweep: vi.fn().mockResolvedValue({ expired: [], orphaned: [] }), readImage: vi.fn(),
    };
    const database = { withAdvisoryLock: vi.fn(async (_name: string, handler: (assertOwned: () => Promise<void>) => Promise<unknown>) => handler(async () => undefined)) };
    const reader = { read: vi.fn().mockResolvedValue(emptySnapshot) };
    const renderer = { render: vi.fn().mockImplementation(async (snap: { orders: Array<{ orderId: number }> }) => snap.orders.map((order, index) => ({ pageIndex: index + 1, orderIds: [order.orderId], png: Buffer.from('png') }))) };
    const runtime = { getConfig: () => options.relayAvailable === false ? { enabled: false, relayOwner: 'external' } : { enabled: true, relayOwner: 'in_process', relayStaleLockMs: 60_000 } };
    const service = new DailyDigestService(repository as never, store as never, database as never, runtime as never, {} as never, reader as never, renderer as never);
    return { service, repository, store, reader, renderer };
  }

  it('derives the effective timing from the frozen chosen minute', () => {
    const schedule = scheduleFor('2026-09-23', '08:52', { sendWindowMinutes: 30, windowEnd: '09:15', catchUpPolicy: 'until_deadline', catchUpDeadline: '10:00' });
    expect(businessTime(new Date(schedule.scheduledAt))).toBe('08:52');
    expect(scheduleTiming(schedule)).toEqual({ sendTime: '08:52', catchUpPolicy: 'until_deadline', catchUpDeadline: '10:00' });
  });

  it('plans the daily schedule before the provider gate without reading orders or images', async () => {
    const { service, repository, store, reader, renderer } = makeAutoService({ relayAvailable: false });
    await service.onModuleInit();
    await service.tick(new Date('2026-09-23T03:50:00.000Z'));
    expect(repository.getOrCreateSchedule).toHaveBeenCalledWith('2026-09-23', expect.any(Function));
    expect(reader.read).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
    expect(repository.createRun).not.toHaveBeenCalled();
    expect(store.writePages).not.toHaveBeenCalled();
  });

  it('draws the offset as an integer inside [0, duration)', async () => {
    const { service, repository } = makeAutoService({ relayAvailable: false });
    await service.onModuleInit();
    await service.tick(new Date('2026-09-23T03:50:00.000Z'));
    const draw = repository.getOrCreateSchedule.mock.calls[0][1] as (duration: number) => number;
    for (let i = 0; i < 300; i += 1) {
      const value = draw(30);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(30);
    }
    expect(draw(1)).toBe(0);
  });

  it('does not read orders or render before the frozen chosen minute, then uses the frozen catch-up policy', async () => {
    const schedule = scheduleFor('2026-09-23', '08:52', { sendWindowMinutes: 30, windowEnd: '09:15', catchUpPolicy: 'until_deadline', catchUpDeadline: '10:00' });
    const { service, repository, reader, renderer } = makeAutoService({ schedule });
    await service.onModuleInit();
    await service.tick(new Date('2026-09-23T03:51:59.999Z'));
    expect(reader.read).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
    expect(repository.createRun).not.toHaveBeenCalled();

    await service.tick(new Date('2026-09-23T03:52:30.000Z'));
    expect(repository.createRun).toHaveBeenCalledOnce();
    const runInput = repository.createRun.mock.calls[0][0];
    expect(runInput.state).toBe('empty');
    // Settings still carry 'skip'; the recorded run uses the frozen policy.
    expect(runInput.catchUpPolicy).toBe('until_deadline');
  });

  it('records a missed-window skip with the frozen policy when settings changed after planning', async () => {
    const schedule = scheduleFor('2026-09-23', '08:45', { catchUpPolicy: 'skip' });
    const { service, repository } = makeAutoService({ schedule, settingsOverride: { catchUpPolicy: 'until_deadline', catchUpDeadline: '23:00' } });
    await service.onModuleInit();
    await service.tick(new Date('2026-09-23T03:46:00.000Z'));
    expect(repository.createRun).toHaveBeenCalledOnce();
    expect(repository.createRun.mock.calls[0][0]).toMatchObject({ state: 'skipped', reason: 'MISSED_WINDOW', catchUpPolicy: 'skip' });
  });

  it('keeps the until_deadline cutoff anchored to the frozen deadline, not the chosen minute', async () => {
    const schedule = scheduleFor('2026-09-23', '09:10', { sendWindowMinutes: 30, windowEnd: '09:15', catchUpPolicy: 'until_deadline', catchUpDeadline: '10:00' });
    const { service, repository } = makeAutoService({ schedule, orders: [{ orderId: 71 }] });
    await service.onModuleInit();
    await service.tick(new Date('2026-09-23T04:59:30.000Z'));
    expect(repository.createRun).toHaveBeenCalledOnce();
    expect(repository.createRun.mock.calls[0][0]).toMatchObject({ state: 'queued', catchUpPolicy: 'until_deadline' });
    expect(repository.createRun.mock.calls[0][0].deadlineAt.toISOString()).toBe('2026-09-23T05:00:59.999Z');
  });

  it('does not plan a schedule while automation is disabled', async () => {
    const { service, repository } = makeAutoService({ settingsOverride: { enabled: false } });
    await service.onModuleInit();
    await service.tick(new Date('2026-09-23T03:50:00.000Z'));
    expect(repository.getOrCreateSchedule).not.toHaveBeenCalled();
  });

  it('exposes the frozen schedule on settings and save envelopes, tolerating a pre-window schema', async () => {
    const schedule = scheduleFor('2026-09-23', '08:52', { sendWindowMinutes: 30, windowEnd: '09:15' });
    const { service, repository } = makeAutoService({ schedule });
    await expect(service.settings()).resolves.toMatchObject({ todaySchedule: schedule });
    await expect(service.updateSettings({ ...settings, duplicateRiskConfirmed: false }, { id: 'actor-1' } as never, 'req-1'))
      .resolves.toMatchObject({ todaySchedule: schedule });
    repository.getSchedule.mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    await expect(service.settings()).resolves.toMatchObject({ todaySchedule: null });
    repository.getSchedule.mockRejectedValueOnce(new Error('connection reset'));
    await expect(service.settings()).rejects.toThrow('connection reset');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientScreenIdFor, ClientScreenOrderSource } from './buildClientScreenSnapshot';
import { createClientScreenEnvironment, type ClientScreenEnvironment, type ClientScreenLocks } from './clientScreenEnvironment';
import { ClientScreenPresenter, FRAME_PUBLISH_MS, type ClientScreenOrderProvider } from './clientScreenPresenter';
import type { ClientScreenPolicy } from './clientScreenPublisherCore';
import { CLIENT_SCREEN_CODES } from './clientScreenRegistry';
import type { ClientScreenFrame, ClientScreenUi } from './clientScreenSnapshotSchema';
import { startClientScreenViewer, type ClientScreenViewer } from './clientScreenViewerRuntime';
import { CLIENT_SCREEN_WORKSTATION_KEY } from './clientScreenWorkstation';

/**
 * Two kinds of "windows" in one process: real BroadcastChannel and real Web Locks (Node provides
 * both), a shared in-memory localStorage with storage events. Each test uses its own channel name.
 */
/**
 * Web Locks for the test process: exclusive named locks with a waiting queue, `ifAvailable`, abort
 * and `query`, the subset the runtimes use, with the timing the specification requires (callbacks
 * run in a later task, a pre-aborted request is rejected). The test runner's Node may have no
 * navigator.locks at all (Node 20 in CI).
 */
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function createLocks(): ClientScreenLocks {
  const held = new Set<string>();
  const waiting = new Map<string, Array<() => void>>();
  const aborted = () => new DOMException('The request was aborted', 'AbortError');
  // The callback runs in a later task, never inside request(); the lock is released when it settles.
  const run = async (name: string, callback: (lock: unknown) => unknown): Promise<unknown> => {
    held.add(name);
    try {
      await Promise.resolve();
      return await callback({ name });
    } finally {
      held.delete(name);
      const next = waiting.get(name)?.shift();
      if (next) next();
    }
  };
  return {
    request(name, options, callback) {
      if (options.signal?.aborted) return Promise.reject(aborted());
      if (!held.has(name)) return run(name, callback);
      if (options.ifAvailable) return Promise.resolve().then(() => callback(null));
      return new Promise((resolve, reject) => {
        const start = () => {
          options.signal?.removeEventListener('abort', onAbort);
          run(name, callback).then(resolve, reject);
        };
        const onAbort = () => {
          const queue = waiting.get(name) ?? [];
          const index = queue.indexOf(start);
          if (index >= 0) queue.splice(index, 1);
          reject(aborted());
        };
        options.signal?.addEventListener('abort', onAbort);
        waiting.set(name, [...(waiting.get(name) ?? []), start]);
      });
    },
    async query() {
      return { held: [...held].map((name) => ({ name })) };
    },
  };
}

/**
 * The substitute is checked against what the Web Locks specification requires of the subset used
 * here. It is not compared with the runner's own navigator.locks: Node's experimental implementation
 * differs from browsers (it calls the callback inside request() and keeps a lock whose callback
 * threw). Real browser locks, including two windows claiming at once and a duplicate customer
 * window, are exercised in Chromium by tests/client-screen-browse.mjs.
 */
const lockManagers: Array<[string, () => ClientScreenLocks]> = [['substitute', createLocks]];

async function eventually(check: () => Promise<boolean>, timeout = 1000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return true;
    await wait(10);
  }
  return false;
}

describe.each(lockManagers)('lock manager conformance: %s', (kind, make) => {
  const name = (suffix: string) => `conformance-${kind}-${process.pid}-${suffix}-${Math.random().toString(36).slice(2)}`;

  it('grants a free lock in a later task and releases it when the callback settles', async () => {
    const locks = make();
    const lock = name('free');
    let entered = false;
    let release!: () => void;
    const done = locks.request(lock, {}, () => { entered = true; return new Promise<void>((resolve) => { release = resolve; }); });
    expect(entered).toBe(false); // never invoked synchronously inside request()
    await until(() => entered, 'callback invoked');
    expect((await locks.query()).held?.some((item) => item.name === lock)).toBe(true);
    release();
    await done;
    // The release becomes visible to other requests a moment after the callback settles.
    expect(await eventually(async () => !(await locks.query()).held?.some((item) => item.name === lock))).toBe(true);
  });

  it('ifAvailable gets null while the lock is held; a queued request gets it after release, in order', async () => {
    const locks = make();
    const lock = name('queue');
    let release!: () => void;
    const order: string[] = [];
    const first = locks.request(lock, {}, () => new Promise<void>((resolve) => { release = resolve; }));
    await until(() => Boolean(release), 'first holder');
    await locks.request(lock, { ifAvailable: true }, (granted) => { order.push(granted === null ? 'null' : 'granted'); });
    const second = locks.request(lock, {}, () => { order.push('second'); });
    const third = locks.request(lock, {}, () => { order.push('third'); });
    await wait(20);
    expect(order).toEqual(['null']);
    release();
    await Promise.all([first, second, third]);
    expect(order).toEqual(['null', 'second', 'third']);
  });

  it('rejects a request whose signal is already aborted without invoking the callback, even for a free lock', async () => {
    const locks = make();
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    await expect(locks.request(name('pre-aborted'), { signal: controller.signal }, () => { invoked = true; })).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoked).toBe(false);
  });

  it('a queued request aborted before its turn is rejected and never runs', async () => {
    const locks = make();
    const lock = name('abort-queued');
    let release!: () => void;
    const first = locks.request(lock, {}, () => new Promise<void>((resolve) => { release = resolve; }));
    await until(() => Boolean(release), 'first holder');
    const controller = new AbortController();
    let invoked = false;
    const queued = locks.request(lock, { signal: controller.signal }, () => { invoked = true; });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    release();
    await first;
    await wait(20);
    expect(invoked).toBe(false);
  });

  it('releases the lock when the callback throws', async () => {
    const locks = make();
    const lock = name('throws');
    await expect(locks.request(lock, {}, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await eventually(async () => {
      let granted: unknown = null;
      await locks.request(lock, { ifAvailable: true }, (value) => { granted = value; });
      return granted !== null;
    })).toBe(true);
  });
});

let channelSeq = 0;

function workstationOf() {
  const locks = createLocks();
  const data = new Map<string, string>();
  const listeners = new Set<(key: string | null) => void>();
  const channelName = `erp-client-screen-test-${process.pid}-${++channelSeq}`;
  const envFor = (options: { now?: () => number; wrapPost?: Parameters<typeof createClientScreenEnvironment>[0]['wrapPost'] } = {}): ClientScreenEnvironment => {
    let mine: ((key: string | null) => void) | null = null;
    return createClientScreenEnvironment({
      channelName,
      locks,
      now: options.now,
      wrapPost: options.wrapPost,
      storage: {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => {
          data.set(key, value);
          // Like the browser: every other window gets a storage event.
          for (const listener of listeners) if (listener !== mine) listener(key);
        },
      },
      onStorageEvent(listener) {
        mine = listener;
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
  };
  return { envFor };
}

async function until(check: () => boolean, label: string, timeout = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error(`timeout: ${label}`);
    await wait(10);
  }
}

function order(name: string): ClientScreenOrderProvider & { source: ClientScreenOrderSource; ui: ClientScreenUi } {
  const provider = {
    source: {
      tabs: [{ key: 'basic' as const, label: 'Основное' }, { key: 'details' as const, label: 'Детали' }],
      summary: { number: name, client: `Клиент ${name}`, parts: '2', area: '1,00 м²', final: '100 ₸', debt: '0 ₸' },
      basic: { client: `Клиент ${name}`, order_name: `Заказ ${name}`, notes: `секрет ${name}` },
      dates: {}, finance: {}, payments: [],
      details: {
        columnOrder: ['name' as const, 'cost' as const],
        rows: [{ key: `${name}-row-1`, values: { name: `Фасад ${name}`, cost: `цена ${name}` } }],
        grouping: null,
      },
      services: [],
    } satisfies ClientScreenOrderSource,
    ui: { tab: 'details', focus: null, editing: null, scroll: null, page: null } as ClientScreenUi,
    getSource() { return provider.source; },
    getUi(_idFor: ClientScreenIdFor) { return provider.ui; },
  };
  return provider;
}

const allCodes: ClientScreenPolicy = { enabled: true, visibleCodes: [...CLIENT_SCREEN_CODES], version: 1 };
const disposables: Array<() => void> = [];
afterEach(async () => {
  while (disposables.length) disposables.pop()!();
  await wait(20);
});

function setup(policy: { current: ClientScreenPolicy } = { current: allCodes }, clock: { offset: number } = { offset: 0 }) {
  const workstation = workstationOf();
  const closed = vi.fn();
  const now = () => Date.now() + clock.offset;
  const startViewer = (): ClientScreenViewer => {
    const viewer = startClientScreenViewer(workstation.envFor({ now }), { close: closed });
    disposables.push(() => viewer.stop());
    return viewer;
  };
  const opened = vi.fn();
  const presenter = (options: {
    wrapPost?: Parameters<typeof createClientScreenEnvironment>[0]['wrapPost']; suspendedTimers?: boolean;
    tweakEnv?: (env: ClientScreenEnvironment) => ClientScreenEnvironment;
  } = {}): ClientScreenPresenter => {
    const base = workstation.envFor({ now, wrapPost: options.wrapPost });
    // A background manager window: its timers do not run, only explicit calls do.
    const timed = options.suspendedTimers ? { ...base, setInterval: () => () => undefined } : base;
    const env = options.tweakEnv ? options.tweakEnv(timed) : timed;
    const instance = new ClientScreenPresenter({ env, loadPolicy: async () => policy.current, openWindow: opened });
    disposables.push(() => instance.dispose());
    return instance;
  };
  return { startViewer, presenter, closed, opened, policy, clock };
}
const shownTitle = (viewer: ClientScreenViewer) => viewer.getState().shown?.snapshot.title ?? null;

describe('customer screen: manager windows and the customer window together', () => {
  it('presents the chosen order with the interface state; the customer window never gets a row key', async () => {
    const { startViewer, presenter } = setup();
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter();
    const first = order('A1');
    a.present('order-1', first);
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'snapshot shown');
    await until(() => viewer.getState().ui?.tab === 'details', 'ui shown');
    expect(a.getView()).toMatchObject({ phase: 'owner', presentedOrderKey: 'order-1', lost: null, policyStale: false });
    expect(JSON.stringify(viewer.getState().shown)).not.toContain('A1-row-1');

    first.source = { ...first.source, basic: { ...first.source.basic, order_name: 'Заказ A1 изменён' } };
    a.notifyChanged('order-1');
    await until(() => JSON.stringify(viewer.getState().shown).includes('Заказ A1 изменён'), 'live edit shown');
    // A change of another order of the same window is not sent.
    a.notifyChanged('order-2');
  });

  it('opens the customer window when there is none and claims after it says hello', async () => {
    const { startViewer, presenter, opened } = setup();
    const a = presenter();
    a.present('order-1', order('A1'));
    await until(() => opened.mock.calls.length === 1, 'window opened');
    expect(a.getView().phase).toBe('idle');
    const viewer = startViewer();
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'snapshot after the window appeared');
  });

  it('a value of a field that is not ticked never reaches the customer window; a settings change is applied in one step', async () => {
    const policy = { current: { enabled: true, visibleCodes: ['summary.number', 'tab.details', 'details.name', 'details.cost'], version: 5 } as ClientScreenPolicy };
    const { startViewer, presenter } = setup(policy);
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter();
    a.present('order-1', order('A1'));
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'snapshot shown');
    expect(JSON.stringify(viewer.getState().shown)).toContain('цена A1');
    expect(JSON.stringify(viewer.getState().shown)).not.toContain('секрет A1');

    policy.current = { enabled: true, visibleCodes: ['summary.number', 'tab.details', 'details.name'], version: 6 };
    await a.reloadPolicy();
    await until(() => viewer.getState().shown?.policyVersion === 6, 'new policy shown');
    expect(JSON.stringify(viewer.getState().shown)).not.toContain('цена A1');
  });

  it('a late settings answer with an older version does not bring the hidden field back', async () => {
    const policy = { current: { enabled: true, visibleCodes: ['summary.number', 'tab.details', 'details.name'], version: 6 } as ClientScreenPolicy };
    const { startViewer, presenter } = setup(policy);
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter();
    a.present('order-1', order('A1'));
    await until(() => viewer.getState().shown?.policyVersion === 6, 'snapshot shown');
    policy.current = { enabled: true, visibleCodes: [...CLIENT_SCREEN_CODES], version: 5 };
    await a.reloadPolicy();
    a.notifyChanged('order-1');
    await wait(80);
    expect(viewer.getState().shown?.policyVersion).toBe(6);
    expect(JSON.stringify(viewer.getState().shown)).not.toContain('цена A1');
  });

  it('the window that pressed the button last presents; the previous one stops for good', async () => {
    const { startViewer, presenter } = setup();
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter();
    const b = presenter();
    const orderA = order('A1');
    a.present('order-1', orderA);
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'A shown');
    b.present('order-2', order('B2'));
    await until(() => shownTitle(viewer) === 'Заказ № B2', 'B shown');
    await until(() => a.getView().phase === 'idle', 'A stopped');
    expect(a.getView()).toMatchObject({ lost: 'taken', presentedOrderKey: null });
    orderA.source = { ...orderA.source, summary: { ...orderA.source.summary, number: 'A1-late' } };
    a.notifyChanged('order-1');
    await wait(80);
    expect(shownTitle(viewer)).toBe('Заказ № B2');
    // B closes (its lock is released without a message): splash, A does not come back.
    (b as unknown as { releaseLock(): void }).releaseLock();
    await until(() => viewer.getState().screen === 'splash', 'splash after the owner is gone');
    await wait(80);
    expect(shownTitle(viewer)).toBeNull();
  });

  it('«Скрыть» shows the splash; the organisation switch stops the presentation', async () => {
    const policy = { current: allCodes };
    const { startViewer, presenter } = setup(policy);
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter();
    a.present('order-1', order('A1'));
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'shown');
    a.hide('other-order');
    await wait(40);
    expect(shownTitle(viewer)).toBe('Заказ № A1');
    a.hide('order-1');
    await until(() => viewer.getState().screen === 'splash', 'splash after hide');

    a.present('order-1', order('A1'));
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'shown again');
    policy.current = { ...allCodes, enabled: false, version: 2 };
    await a.reloadPolicy();
    await until(() => viewer.getState().screen === 'splash', 'splash after the organisation switch');
    expect(a.getView()).toMatchObject({ phase: 'idle', lost: 'policy' });
  });

  it('after the customer window restarts the owner continues without a new click', async () => {
    const { startViewer, presenter } = setup();
    const first = startViewer();
    await until(() => first.getRole() === 'viewer', 'viewer lock');
    const a = presenter();
    a.present('order-1', order('A1'));
    await until(() => shownTitle(first) === 'Заказ № A1', 'shown');
    const epoch = first.getState().epoch;
    first.stop();
    await wait(30);
    const second = startViewer();
    await until(() => shownTitle(second) === 'Заказ № A1', 'shown after restart');
    expect(second.getState().epoch).toBeGreaterThan(epoch);
    expect(a.getView().phase).toBe('owner');
  });

  it('emergency switch-off from another tab stops the owner and the customer window; nothing old comes back after re-enabling', async () => {
    const { startViewer, presenter, closed } = setup();
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter();
    const b = presenter();
    const orderA = order('A1');
    a.present('order-1', orderA);
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'A shown');

    await b.disableWorkstation();
    await until(() => viewer.getState().screen === 'disabled', 'customer window disabled');
    await until(() => a.getView().phase === 'idle', 'owner stopped');
    expect(closed).toHaveBeenCalled();
    expect(a.getView()).toMatchObject({ lost: 'disabled', workstationDisabled: true, presentedOrderKey: null });
    // While switched off nobody can present.
    a.present('order-1', orderA);
    await wait(60);
    expect(viewer.getState().screen).toBe('disabled');

    await b.enableWorkstation();
    await until(() => viewer.getState().screen === 'splash', 'splash after re-enabling');
    a.notifyChanged('order-1');
    await wait(80);
    expect(shownTitle(viewer)).toBeNull();
    // Only a new press of the button presents again.
    a.present('order-1', orderA);
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'shown after a new claim');
  });

  it('an error while building the snapshot switches the workstation off and never throws into the order form', async () => {
    const { startViewer, presenter } = setup();
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter();
    const broken = order('A1');
    a.present('order-1', broken);
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'shown');
    broken.getSource = () => { throw new Error('boom'); };
    expect(() => a.notifyChanged('order-1')).not.toThrow();
    await until(() => viewer.getState().screen === 'disabled', 'disabled after the error');
    await until(() => a.getView().workstationDisabled && a.getView().lost === 'error', 'presenter reports the error');
  });

  it('the editor value of a field that is not ticked never reaches the customer window, also when the settings change during the edit', async () => {
    const policy = { current: { enabled: true, visibleCodes: ['summary.number', 'tab.details', 'details.name', 'details.cost'], version: 5 } as ClientScreenPolicy };
    const { startViewer, presenter } = setup(policy);
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter();
    const edited = order('A1');
    edited.getUi = (idFor) => ({
      tab: 'details', focus: { code: 'details.cost', rowId: idFor('detail', 'A1-row-1') },
      editing: { rowId: idFor('detail', 'A1-row-1'), values: [{ code: 'details.name', value: 'новое имя' }, { code: 'details.cost', value: 'EDITED-COST' }] },
      scroll: null, page: null,
    });
    a.present('order-1', edited);
    await until(() => viewer.getState().ui?.editing?.values.length === 2, 'both editor values shown while cost is ticked');

    policy.current = { enabled: true, visibleCodes: ['summary.number', 'tab.details', 'details.name'], version: 6 };
    await a.reloadPolicy();
    await until(() => viewer.getState().shown?.policyVersion === 6 && viewer.getState().ui !== null, 'new policy and its ui shown');
    a.notifyUi('order-1');
    await wait(60);
    const wire = JSON.stringify([viewer.getState().shown, viewer.getState().ui]);
    expect(wire).not.toContain('EDITED-COST');
    expect(wire).not.toContain('цена A1');
    expect(viewer.getState().ui).toMatchObject({ focus: null, editing: { values: [{ code: 'details.name', value: 'новое имя' }] } });
  });

  it('two windows claiming at the same moment: the later claim presents, neither side is left with a dead presentation', async () => {
    const { startViewer, presenter } = setup();
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter();
    const b = presenter();
    a.present('order-1', order('A1'));
    b.present('order-2', order('B2'));
    await until(() => shownTitle(viewer) !== null && [a, b].filter((p) => p.getView().phase === 'owner').length === 1
      && [a, b].filter((p) => p.getView().phase === 'idle').length === 1, 'exactly one owner');
    const winner = a.getView().phase === 'owner' ? 'Заказ № A1' : 'Заказ № B2';
    expect(shownTitle(viewer)).toBe(winner);
    // Pressing the button again in the same window works as well.
    a.present('order-1', order('A1'));
    a.present('order-1', order('A9'));
    await until(() => shownTitle(viewer) === 'Заказ № A9', 'repeated press presents the last one');
  });

  it('a press that is still waiting for the customer window dies with a switch-off, even one already undone', async () => {
    const { startViewer, presenter, opened } = setup();
    const a = presenter();
    const b = presenter();
    a.present('order-1', order('A1'));
    await until(() => opened.mock.calls.length === 1, 'window requested');
    await b.disableWorkstation();
    await b.enableWorkstation();
    const viewer = startViewer(); // the delayed hello arrives after the re-enable
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    await wait(150);
    expect(shownTitle(viewer)).toBeNull();
    expect(viewer.getState().owner).toBeNull();
    expect(a.getView()).toMatchObject({ phase: 'idle', presentedOrderKey: null });
  });

  it('after the customer window blanked by its own clock, the next successful settings re-read brings the order back', async () => {
    const clock = { offset: 0 };
    const { startViewer, presenter } = setup({ current: allCodes }, clock);
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter({ suspendedTimers: true });
    a.present('order-1', order('A1'));
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'shown');
    // Time passes while the manager window's timers are suspended: only the customer window ticks.
    clock.offset = 61_000;
    await until(() => viewer.getState().screen === 'splash', 'customer window blanked by validity', 2500);
    await a.reloadPolicy(); // same version, no publisher tick in between
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'shown again after the re-read');
  });

  it('messages of one re-read lost on the way: the customer window blanks by its clock and the next re-read brings the order back', async () => {
    const clock = { offset: 0 };
    const { startViewer, presenter } = setup({ current: allCodes }, clock);
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const dropping = { on: false };
    const a = presenter({ suspendedTimers: true, wrapPost: (post) => (message) => { if (!dropping.on) post(message); } });
    a.present('order-1', order('A1'));
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'shown');
    // A successful re-read whose snapshot and confirmation never arrive in time.
    dropping.on = true;
    clock.offset = 30_000;
    await a.reloadPolicy();
    clock.offset = 61_000;
    await until(() => viewer.getState().screen === 'splash', 'customer window blanked by validity', 2500);
    // Later re-reads do not rely on the earlier confirmation having arrived.
    dropping.on = false;
    await a.reloadPolicy();
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'shown again');
    await a.reloadPolicy();
    await wait(50);
    expect(shownTitle(viewer)).toBe('Заказ № A1');
  });

  it('a channel that starts failing ends the presentation locally: lock released, references dropped, nothing thrown', async () => {
    const { startViewer, presenter } = setup();
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const failing = { on: false };
    const a = presenter({ wrapPost: (post) => (message) => { if (failing.on) throw new Error('channel closed'); post(message); } });
    a.present('order-1', order('A1'));
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'shown');
    failing.on = true;
    expect(() => a.notifyChanged('order-1')).not.toThrow();
    // The owner lock is released, so the customer window sees the owner gone and blanks.
    await until(() => viewer.getState().screen !== 'order', 'customer window no longer shows the order');
    await until(() => a.getView().phase === 'idle' && a.getView().presentedOrderKey === null && a.getView().lost === 'error', 'presenter cleaned up');
    // What could not be delivered is not offered as "what the customer sees".
    expect(a.getPreview()).toBeNull();
    await wait(80);
    expect(a.getPreview()).toBeNull();
  });

  it('a tab hidden by the settings, or not mirrored at all, leaves the customer on the last tab shown', async () => {
    const policy = { current: { enabled: true, visibleCodes: ['summary.number', 'tab.basic', 'basic.client', 'tab.details', 'details.name'], version: 3 } as ClientScreenPolicy };
    const { startViewer, presenter } = setup(policy);
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter();
    const shownOrder = order('A1');
    shownOrder.source = { ...shownOrder.source, tabs: [{ key: 'basic', label: 'Основное' }, { key: 'details', label: 'Детали' }, { key: 'finance', label: 'Финансы' }] };
    a.present('order-1', shownOrder);
    await until(() => viewer.getState().ui?.tab === 'details', 'details shown');
    // Finance is a mirrored tab, but the settings hide it: the customer stays on details, not on the first tab.
    shownOrder.ui = { ...shownOrder.ui, tab: 'finance' };
    a.notifyUi('order-1');
    await wait(60);
    expect(viewer.getState().ui?.tab).toBe('details');
    // A tab the customer screen does not mirror at all.
    shownOrder.ui = { ...shownOrder.ui, tab: null };
    a.notifyUi('order-1');
    await wait(60);
    expect(viewer.getState().ui?.tab).toBe('details');
    shownOrder.ui = { ...shownOrder.ui, tab: 'basic' };
    a.notifyUi('order-1');
    await until(() => viewer.getState().ui?.tab === 'basic', 'visible tab followed');
    // A new presentation starts without a remembered tab.
    a.hide('order-1');
    shownOrder.ui = { ...shownOrder.ui, tab: 'finance' };
    a.present('order-1', shownOrder);
    await until(() => viewer.getState().ui !== null && viewer.getState().shown !== null, 'presented again');
    expect(viewer.getState().ui?.tab).toBe('basic');
  });

  it('the order screen goes away while its tab stays: the customer keeps the order; the settings still apply; the screen comes back live', async () => {
    const policy = { current: allCodes };
    const { startViewer, presenter } = setup(policy);
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter();
    const shownOrder = order('A1');
    shownOrder.ui = { tab: 'details', focus: { code: 'details.name' }, editing: null, scroll: { ratio: 0.4 }, page: null };
    a.present('order-1', shownOrder);
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'presented');
    await until(() => viewer.getState().ui?.scroll?.ratio === 0.4, 'ui shown');

    // The last state of the screen is taken at the moment it goes away.
    shownOrder.source = { ...shownOrder.source, basic: { ...shownOrder.source.basic, order_name: 'Заказ A1 перед уходом' } };
    a.detach('order-1', shownOrder);
    await until(() => JSON.stringify(viewer.getState().shown).includes('Заказ A1 перед уходом'), 'kept state shown');
    expect(a.getView()).toMatchObject({ phase: 'owner', presentedOrderKey: 'order-1' });
    // Nothing is pointed at any more; the tab and the scroll position stay.
    await until(() => viewer.getState().ui?.focus === null, 'focus mark gone');
    expect(viewer.getState().ui).toMatchObject({ tab: 'details', scroll: { ratio: 0.4 } });

    // Later changes of the gone screen object are not read.
    shownOrder.source = { ...shownOrder.source, basic: { ...shownOrder.source.basic, order_name: 'ПОСЛЕ УХОДА' } };
    a.notifyChanged('order-1');
    await wait(80);
    expect(JSON.stringify(viewer.getState().shown)).not.toContain('ПОСЛЕ УХОДА');

    // A settings change still filters what is kept.
    policy.current = { enabled: true, visibleCodes: ['summary.number', 'tab.details', 'details.name'], version: 2 };
    await a.reloadPolicy();
    await until(() => !JSON.stringify(viewer.getState().shown).includes('Заказ A1 перед уходом'), 'kept state filtered again');
    expect(JSON.stringify(viewer.getState().shown)).toContain('Фасад A1');
    expect(JSON.stringify(viewer.getState().shown)).not.toContain('цена A1');

    // The screen is mounted again: live once more.
    const back = order('A1');
    back.source = { ...back.source, details: { ...back.source.details, rows: [{ key: 'A1-row-1', values: { name: 'Фасад A1 снова живой', cost: 'x' } }] } };
    a.attach('order-1', back);
    await until(() => JSON.stringify(viewer.getState().shown).includes('Фасад A1 снова живой'), 'live again');
    // Attaching the screen of another order does nothing.
    const other = order('B2');
    a.attach('order-2', other);
    a.detach('order-2', other);
    await wait(60);
    expect(shownTitle(viewer)).toBe('Заказ № A1');
    expect(a.getView().presentedOrderKey).toBe('order-1');
  });

  it('a screen that goes away before anything was shown ends the presentation', async () => {
    const { presenter, opened } = setup();
    const a = presenter();
    const failing = order('A1');
    a.present('order-1', failing);
    await until(() => opened.mock.calls.length === 1, 'window requested');
    failing.getSource = () => { throw new Error('screen is gone'); };
    a.detach('order-1', failing);
    expect(a.getView().presentedOrderKey).toBeNull();
  });

  it('the preview is exactly what was sent: filtered data and interface state; it is gone with the presentation', async () => {
    const policy = { current: { enabled: true, visibleCodes: ['summary.number', 'tab.details', 'details.name'], version: 1 } as ClientScreenPolicy };
    const { startViewer, presenter } = setup(policy);
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter();
    const changes = vi.fn();
    a.subscribePreview(changes);
    expect(a.getPreview()).toBeNull();
    const shownOrder = order('A1');
    a.present('order-1', shownOrder);
    await until(() => shownTitle(viewer) === 'Заказ № A1' && viewer.getState().ui !== null, 'presented');
    const preview = a.getPreview();
    expect(preview?.snapshot).toEqual(viewer.getState().shown?.snapshot);
    expect(preview?.ui).toEqual(viewer.getState().ui);
    expect(JSON.stringify(preview)).not.toContain('цена A1');
    expect(JSON.stringify(preview)).not.toContain('секрет A1');
    expect(changes).toHaveBeenCalled();
    shownOrder.ui = { ...shownOrder.ui, scroll: { ratio: 0.7 } };
    a.notifyUi('order-1');
    expect(a.getPreview()?.ui?.scroll?.ratio).toBe(0.7);
    a.hide('order-1');
    expect(a.getPreview()).toBeNull();
  });

  it('a window that presents nothing learns that another window does, and that it stopped', async () => {
    const { startViewer, presenter } = setup();
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter();
    const idle = presenter();
    expect(idle.getView().presentingElsewhere).toBe(false);
    a.present('order-1', order('A1'));
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'presented');
    await until(() => idle.getView().presentingElsewhere, 'the idle window sees the presentation', 6000);
    expect(idle.getView().presentedOrderKey).toBeNull();
    // The presenting window itself does not count its own presentation as "elsewhere".
    await wait(2500);
    expect(a.getView().presentingElsewhere).toBe(false);
    a.hide('order-1');
    await until(() => !idle.getView().presentingElsewhere, 'the idle window sees it stopped', 6000);
  }, 20000);

  it('a customer window of an earlier build is not used: it is told to close and a window of this build is opened', async () => {
    const { startViewer, presenter, opened } = setup();
    // The old window: holds the viewer lock of the previous version and listens on the previous channel.
    let oldEnv: ClientScreenEnvironment | null = null;
    const a = presenter({ tweakEnv: (env) => { oldEnv = env; return env; } });
    let releaseOld: () => void = () => undefined;
    void oldEnv!.locks.request('erp-client-screen-viewer', {}, () => new Promise<void>((resolve) => { releaseOld = resolve; }));
    const oldChannel = new BroadcastChannel('erp-client-screen');
    const received: unknown[] = [];
    oldChannel.onmessage = (event) => received.push(event.data);
    disposables.push(() => { releaseOld(); oldChannel.close(); });
    await wait(30);

    const shownOrder = order('A1');
    shownOrder.source = { ...shownOrder.source, summary: { ...shownOrder.source.summary, client_phone: '8 705 222 3344' } };
    a.present('order-1', shownOrder);
    // The old window's lock does not count as a customer window: a new one is requested…
    await until(() => opened.mock.calls.length === 1, 'a window of this build is requested');
    // …and the old one gets the closing message of its own version, nothing else.
    await until(() => received.length > 0, 'old window told to close');
    expect(received).toEqual([{ v: 1, t: 'shutdown' }]);

    const viewer = startViewer();
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'presented in the window of this build');
    expect(JSON.stringify(viewer.getState().shown)).toContain('8 705 222 3344');
    // Later changes and settings re-reads keep arriving there.
    shownOrder.source = { ...shownOrder.source, summary: { ...shownOrder.source.summary, client_phone: '8 701 000 0000' } };
    a.notifyChanged('order-1');
    await until(() => JSON.stringify(viewer.getState().shown).includes('8 701 000 0000'), 'change shown');
    await a.reloadPolicy();
    expect(JSON.stringify(viewer.getState().shown)).toContain('8 701 000 0000');
    expect(received).toHaveLength(1);
  });

  it('a window of this build sees a presentation run by a window of the previous build, and its emergency switch-off reaches that build', async () => {
    const { presenter } = setup();
    let env: ClientScreenEnvironment | null = null;
    const idle = presenter({ tweakEnv: (value) => { env = value; return value; } });
    // The other tab still runs the previous build and presents: it holds an owner lock of that build.
    let releaseOldOwner: () => void = () => undefined;
    void env!.locks.request('erp-client-screen-owner-5', {}, () => new Promise<void>((resolve) => { releaseOldOwner = resolve; }));
    disposables.push(() => releaseOldOwner());
    await until(() => idle.getView().presentingElsewhere, 'presentation of the previous build is seen', 6000);
    expect(idle.getView().presentedOrderKey).toBeNull();

    // The switch-off goes through the workstation record, which every build reads under the same key.
    const before = env!.readWorkstation();
    await idle.disableWorkstation();
    const after = env!.readWorkstation();
    expect(after.disabled).toBe(true);
    expect(after.gen).toBeGreaterThan(before.gen);
    expect(CLIENT_SCREEN_WORKSTATION_KEY).toBe('erp.clientScreen.workstation');
    // A window that only reads that record (as the previous build's owner and customer window do) sees it.
    const witness = presenter();
    expect(witness.getView().workstationDisabled).toBe(true);
    // When that old owner lets go, the indicator has nothing to show any more.
    releaseOldOwner();
    await until(() => !idle.getView().presentingElsewhere, 'old presentation gone', 6000);
  }, 20000);

  it('a second customer window stays passive', async () => {
    const { startViewer } = setup();
    const first = startViewer();
    await until(() => first.getRole() === 'viewer', 'first viewer');
    const second = startViewer();
    await until(() => second.getRole() === 'duplicate', 'second is a duplicate');
  });
});

describe('customer screen: a tab shown whole', () => {
  const frame = (label: string): ClientScreenFrame => ({
    tab: 'cut', viewport: { w: 1500, h: 900 }, port: { w: 1500, h: 900 }, left: 0, top: 100, width: 1200, height: 600,
    tree: { t: 'div', c: [label] }, shells: [], root: { htmlCls: '', bodyCls: '', htmlData: {}, bodyData: {}, htmlStyle: '', bodyStyle: '' }, styles: ['.a { }'],
  });
  const withCut = (name: string) => {
    const provider = order(name);
    (provider as { source: ClientScreenOrderSource }).source = { ...provider.source, tabs: [...provider.source.tabs, { key: 'cut' as const, label: 'Раскрой' }, { key: 'additional' as const, label: 'Дополнительно' }], frame: frame('Задание 1') };
    provider.ui = { ...provider.ui, tab: 'cut', scroll: { ratio: 0, frameTop: 40 } };
    return provider;
  };
  const shownFrame = (viewer: ClientScreenViewer) => viewer.getState().shown?.snapshot.frame ?? null;
  const ticked = (...codes: string[]): ClientScreenPolicy => ({ enabled: true, visibleCodes: ['summary.number', 'tab.basic', 'tab.details', 'details.name', ...codes], version: 1 });

  it('reaches the customer only with the tick of that tab, and goes away when the tick is taken off', async () => {
    const policy = { current: ticked() };
    const { startViewer, presenter } = setup(policy);
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter();
    const shown = withCut('A1');
    a.present('order-1', shown);
    await until(() => shownTitle(viewer) === 'Заказ № A1', 'snapshot shown');
    expect(a.isCodeVisible('tab.cut')).toBe(false);
    expect(a.isCodeVisible('tab.details')).toBe(true);
    expect(shownFrame(viewer)).toBeNull();
    expect(JSON.stringify(viewer.getState().shown)).not.toContain('Задание 1');

    policy.current = { ...ticked('tab.cut'), version: 2 };
    await a.reloadPolicy();
    await until(() => shownFrame(viewer) !== null, 'copy shown');
    expect(a.isCodeVisible('tab.cut')).toBe(true);
    expect(shownFrame(viewer)?.tree).toEqual({ t: 'div', c: ['Задание 1'] });
    await until(() => viewer.getState().ui?.scroll?.frameTop === 40, 'scroll offset shown');

    policy.current = { ...ticked(), version: 3 };
    await a.reloadPolicy();
    await until(() => viewer.getState().shown?.policyVersion === 3, 'new settings shown');
    expect(shownFrame(viewer)).toBeNull();
    expect(viewer.getState().shown?.snapshot.tabs.map((tab) => tab.key)).not.toContain('cut');
    expect(a.isCodeVisible('tab.cut')).toBe(false);
  });

  it('stays while the manager is on a tab the customer does not see, and stops travelling on a tab the customer does see', async () => {
    const { startViewer, presenter } = setup({ current: ticked('tab.cut', 'basic.order_name') });
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter();
    const shown = withCut('A1');
    a.present('order-1', shown);
    await until(() => shownFrame(viewer) !== null, 'copy shown');

    // «Дополнительно» is not ticked: the customer stays on the cut tab with its copy.
    shown.ui = { ...shown.ui, tab: 'additional' };
    a.notifyUi('order-1');
    shown.source = { ...shown.source, basic: { ...shown.source.basic, order_name: 'переименован' } };
    a.notifyChanged('order-1');
    await until(() => JSON.stringify(viewer.getState().shown).includes('переименован'), 'change shown');
    expect(viewer.getState().ui?.tab).toBe('cut');
    expect(shownFrame(viewer)?.tree).toEqual({ t: 'div', c: ['Задание 1'] });

    // A fresh customer window (reload) gets the kept copy as well.
    viewer.stop();
    const again = startViewer();
    await until(() => shownFrame(again) !== null, 'copy after reload');
    await until(() => again.getState().ui?.tab === 'cut', 'tab after reload');

    // On a tab the customer sees, the heavy copy is no longer sent…
    shown.ui = { ...shown.ui, tab: 'details' };
    a.notifyUi('order-1');
    a.notifyChanged('order-1');
    await until(() => again.getState().ui?.tab === 'details' && shownFrame(again) === null, 'details without the copy');
    // …and is back at once when the manager returns.
    shown.ui = { ...shown.ui, tab: 'cut' };
    a.notifyChanged('order-1');
    await until(() => shownFrame(again) !== null && again.getState().ui?.tab === 'cut', 'copy back');
  });

  it('is kept when the order screen goes away with its order still presented', async () => {
    const { startViewer, presenter } = setup({ current: ticked('tab.cut') });
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter();
    const shown = withCut('A1');
    a.present('order-1', shown);
    await until(() => shownFrame(viewer) !== null, 'copy shown');
    a.detach('order-1', shown);
    // The form is gone: whatever it would answer now must not matter.
    shown.source = { ...shown.source, frame: undefined };
    viewer.stop();
    const again = startViewer();
    await until(() => shownFrame(again) !== null, 'copy after the form went away');
    expect(shownFrame(again)?.tree).toEqual({ t: 'div', c: ['Задание 1'] });
    a.hide('order-1');
    await until(() => again.getState().shown === null, 'gone with the presentation');
  });

  it('snapshots with a copy go no more often than the limit, however fast the order changes; a blank is never delayed', async () => {
    const states: Array<{ at: number; mode: string; frame: boolean }> = [];
    const clock = { offset: 0 };
    const { startViewer, presenter } = setup({ current: ticked('tab.cut') }, clock);
    const viewer = startViewer();
    await until(() => viewer.getRole() === 'viewer', 'viewer lock');
    const a = presenter({
      wrapPost: (post) => (message) => {
        if (message.t === 'state') states.push({ at: Date.now(), mode: message.mode, frame: Boolean(message.snapshot?.frame) });
        post(message);
      },
    });
    const shown = withCut('A1');
    a.present('order-1', shown);
    await until(() => shownFrame(viewer) !== null, 'copy shown');
    await wait(FRAME_PUBLISH_MS + 50);
    states.length = 0;

    const started = Date.now();
    for (let i = 0; i < 50; i += 1) {
      shown.source = { ...shown.source, frame: frame(`Задание ${i}`) };
      a.notifyChanged('order-1');
      await wait(4);
    }
    const spent = Date.now() - started;
    await until(() => JSON.stringify(shownFrame(viewer)?.tree).includes('Задание 49'), 'last state shown', 2000);
    const sent = states.filter((state) => state.frame);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThanOrEqual(Math.floor(spent / FRAME_PUBLISH_MS) + 2);
    for (let i = 1; i < sent.length; i += 1) expect(sent[i].at - sent[i - 1].at).toBeGreaterThanOrEqual(FRAME_PUBLISH_MS - 30);

    // The settings can no longer be confirmed: the blank goes on the next tick, not after the limit.
    shown.source = { ...shown.source, frame: frame('после') };
    a.notifyChanged('order-1');
    clock.offset += 61_000;
    await until(() => viewer.getState().shown === null, 'blank shown', 1500);
    expect(JSON.stringify(states.filter((state) => state.mode === 'order').at(-1) ?? {})).not.toContain('после');
  });
});

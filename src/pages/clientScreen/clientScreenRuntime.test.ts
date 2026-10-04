import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientScreenIdFor, ClientScreenOrderSource } from './buildClientScreenSnapshot';
import { createClientScreenEnvironment, type ClientScreenEnvironment, type ClientScreenLocks } from './clientScreenEnvironment';
import { ClientScreenPresenter, type ClientScreenOrderProvider } from './clientScreenPresenter';
import type { ClientScreenPolicy } from './clientScreenPublisherCore';
import { CLIENT_SCREEN_CODES } from './clientScreenRegistry';
import type { ClientScreenUi } from './clientScreenSnapshotSchema';
import { startClientScreenViewer, type ClientScreenViewer } from './clientScreenViewerRuntime';

/**
 * Two kinds of "windows" in one process: real BroadcastChannel and real Web Locks (Node provides
 * both), a shared in-memory localStorage with storage events. Each test uses its own channel name.
 */
/**
 * Web Locks for the test process: exclusive named locks with a waiting queue, `ifAvailable`, abort
 * and `query`, the subset the runtimes use. The test runner's Node may have no navigator.locks; the
 * real browser implementation is exercised by tests/client-screen-browse.mjs.
 */
function createLocks(): ClientScreenLocks {
  const held = new Set<string>();
  const waiting = new Map<string, Array<() => void>>();
  const run = async (name: string, callback: (lock: unknown) => unknown): Promise<unknown> => {
    held.add(name);
    try {
      return await callback({ name });
    } finally {
      held.delete(name);
      const next = waiting.get(name)?.shift();
      if (next) next();
    }
  };
  return {
    request(name, options, callback) {
      if (!held.has(name)) return run(name, callback);
      if (options.ifAvailable) return Promise.resolve(callback(null));
      return new Promise((resolve, reject) => {
        const start = () => {
          options.signal?.removeEventListener('abort', onAbort);
          run(name, callback).then(resolve, reject);
        };
        const onAbort = () => {
          const queue = waiting.get(name) ?? [];
          const index = queue.indexOf(start);
          if (index >= 0) queue.splice(index, 1);
          reject(new DOMException('aborted', 'AbortError'));
        };
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        options.signal?.addEventListener('abort', onAbort);
        waiting.set(name, [...(waiting.get(name) ?? []), start]);
      });
    },
    async query() {
      return { held: [...held].map((name) => ({ name })) };
    },
  };
}
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
  const presenter = (options: { wrapPost?: Parameters<typeof createClientScreenEnvironment>[0]['wrapPost']; suspendedTimers?: boolean } = {}): ClientScreenPresenter => {
    const base = workstation.envFor({ now, wrapPost: options.wrapPost });
    // A background manager window: its timers do not run, only explicit calls do.
    const env = options.suspendedTimers ? { ...base, setInterval: () => () => undefined } : base;
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
  });

  it('a second customer window stays passive', async () => {
    const { startViewer } = setup();
    const first = startViewer();
    await until(() => first.getRole() === 'viewer', 'first viewer');
    const second = startViewer();
    await until(() => second.getRole() === 'duplicate', 'second is a duplicate');
  });
});

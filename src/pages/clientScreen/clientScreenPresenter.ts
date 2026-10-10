import {
  buildClientScreenSnapshot, createClientScreenIdMap, filterClientScreenUi, withShownFrameOnly, resolveClientScreenTab, type ClientScreenIdFor,
  type ClientScreenOrderSource,
} from './buildClientScreenSnapshot';
import type { ClientScreenEnvironment } from './clientScreenEnvironment';
import {
  CLIENT_SCREEN_ANY_OWNER_LOCK_PREFIX, CLIENT_SCREEN_VIEWER_LOCK, clientScreenMessage, clientScreenOwnerLock, type ClientScreenMessage,
} from './clientScreenProtocol';
import {
  POLICY_REFRESH_MS, createPublisherState, publisherApplyPolicy, publisherCanPublish, publisherClaim, publisherConfirm, publisherOnLockHeld,
  publisherOnMessage, publisherRelease, publisherState, publisherTick, publisherUi, type ClientScreenPolicy, type PublisherLoss, type PublisherState,
} from './clientScreenPublisherCore';
import type { ClientScreenSnapshot, ClientScreenTabKey, ClientScreenUi } from './clientScreenSnapshotSchema';
import { clientScreenAllowed } from './clientScreenWorkstation';

/** The shortest time between two full snapshots when the previous one carried a whole-tab copy. */
export const FRAME_PUBLISH_MS = 400;

/**
 * The manager window side of the customer screen: one per app window. It claims the presentation,
 * keeps the owner lock, re-reads the settings, builds the filtered snapshot of the presented order
 * and sends it. Every entry point is guarded: an error here switches the customer screen off on
 * this workstation and never reaches the order form.
 */
export interface ClientScreenOrderProvider {
  /** Current display state of the presented order. */
  getSource(): ClientScreenOrderSource;
  /**
   * Current interface state; row ids are resolved with `idFor`. `tab` is the manager's own tab (null
   * on a tab the customer screen does not mirror); the presenter decides what the customer sees.
   */
  getUi(idFor: ClientScreenIdFor): ClientScreenUi;
}

export interface ClientScreenPresenterView {
  phase: PublisherState['phase'];
  presentedOrderKey: string | null;
  lost: PublisherLoss | null;
  workstationDisabled: boolean;
  /** The settings could not be confirmed in time: the customer sees the splash until they are. */
  policyStale: boolean;
  /** Another window of this browser presents an order to the customer right now. */
  presentingElsewhere: boolean;
}

/** What was sent to the customer window last: exactly this is on the customer's screen. */
export interface ClientScreenPreview {
  snapshot: ClientScreenSnapshot;
  ui: ClientScreenUi | null;
}

export interface ClientScreenPresenterDeps {
  env: ClientScreenEnvironment;
  loadPolicy(): Promise<ClientScreenPolicy>;
  /** Opens the customer window when none exists. */
  openWindow(): void;
}

const VIEWER_WAIT_MS = 8000;
/** How often a window that presents nothing looks whether another window does. */
const ELSEWHERE_CHECK_MS = 2000;

export class ClientScreenPresenter {
  private state: PublisherState;
  private view: ClientScreenPresenterView;
  private readonly listeners = new Set<() => void>();
  private readonly previewListeners = new Set<() => void>();
  private preview: ClientScreenPreview | null = null;
  /** The display state read from the order screen last; kept when that screen goes away. */
  private lastSource: ClientScreenOrderSource | null = null;
  private lastRawUi: ClientScreenUi | null = null;
  private channel: { post(message: ClientScreenMessage): void; close(): void } | null = null;
  private stops: Array<() => void> = [];
  private provider: ClientScreenOrderProvider | null = null;
  private orderKey: string | null = null;
  private idFor: ClientScreenIdFor;
  private releaseOwnerLock: (() => void) | null = null;
  private lockedEpoch = 0;
  private requestSeq = 0;
  private lastPolicyAt = 0;
  /** Nothing of the current epoch is on the customer screen (not sent yet, or blanked). */
  private blanked = false;
  /** The snapshot sent last; the interface state is filtered against it. */
  private lastSnapshot: ClientScreenSnapshot | null = null;
  /** The tab the customer saw last: kept while the manager is on a tab the customer may not see. */
  private lastCustomerTab: ClientScreenTabKey | null = null;
  private scheduled = false;
  /** When a snapshot with a whole-tab copy was sent last: the next full snapshot waits out FRAME_PUBLISH_MS. */
  private frameSentAt: number | null = null;
  private elsewhere = false;
  private elsewhereCheckedAt = 0;
  /** One press of «Показать клиенту»: its number and the workstation generation read at the press. */
  private attempt = 0;
  private pending: { attempt: number; gen: number; claim: () => void; stopWait: () => void } | null = null;

  constructor(private readonly deps: ClientScreenPresenterDeps) {
    this.state = createPublisherState(deps.env.randomId());
    this.idFor = createClientScreenIdMap(() => deps.env.randomId());
    this.view = this.computeView();
    this.guard(() => {
      this.channel = deps.env.openChannel((message) => this.guard(() => this.onMessage(message)));
      this.stops.push(deps.env.onWorkstationChange(() => this.guard(() => this.tick())));
      this.stops.push(deps.env.setInterval(() => this.guard(() => this.tick()), 1000));
    });
  }

  getView = (): ClientScreenPresenterView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** What the customer sees right now (the last snapshot and interface state sent), or null. */
  getPreview = (): ClientScreenPreview | null => this.preview;

  subscribePreview = (listener: () => void): (() => void) => {
    this.previewListeners.add(listener);
    return () => this.previewListeners.delete(listener);
  };

  /**
   * The screen of the presented order is going away while its workspace tab stays (the manager
   * switched to another tab and the app unloaded this one): the customer keeps seeing the order as
   * it was. The settings still apply — every re-read filters the kept state again.
   */
  detach(orderKey: string, provider: ClientScreenOrderProvider): void {
    this.guard(() => {
      if (orderKey !== this.orderKey || this.provider !== provider) return;
      let source = this.lastSource;
      let ui = this.lastRawUi;
      try {
        source = provider.getSource();
        ui = provider.getUi(this.idFor);
      } catch {
        // the screen is already half gone: what was read last is good enough
      }
      if (!source) {
        this.forget('released');
        return;
      }
      const kept = { source, ui: ui ?? { tab: null, focus: null, editing: null, scroll: null, page: null } };
      // Nothing is being typed or pointed at any more.
      const still: ClientScreenUi = { ...kept.ui, focus: null, editing: null };
      this.provider = { getSource: () => kept.source, getUi: () => still };
      this.publish();
    });
  }

  /** The screen of the presented order is back: it is the live source again. */
  attach(orderKey: string, provider: ClientScreenOrderProvider): void {
    this.guard(() => {
      if (orderKey !== this.orderKey || this.provider === provider) return;
      this.provider = provider;
      this.publish();
    });
  }

  /** «Показать клиенту» for one order. */
  present(orderKey: string, provider: ClientScreenOrderProvider): void {
    this.guard(() => {
      const workstation = this.deps.env.readWorkstation();
      this.cancelPending();
      if (workstation.disabled) {
        this.refresh();
        return;
      }
      if (this.state.phase !== 'idle') this.apply(publisherRelease(this.state));
      this.releaseLock();
      this.provider = provider;
      this.orderKey = orderKey;
      // A customer window of an earlier build cannot show this build's data: it is told to close,
      // and the window of this version is found (or opened) below.
      this.deps.env.retireOldViewers();
      this.idFor = createClientScreenIdMap(() => this.deps.env.randomId());
      this.blanked = false;
      this.lastSnapshot = null;
      this.lastCustomerTab = null;
      this.lastSource = null;
      this.lastRawUi = null;
      this.setPreview(null);
      // This press is valid only for the generation it was made in: a switch-off in between, even
      // one that is already undone, cancels it. Checked again after every asynchronous step.
      const attempt = ++this.attempt;
      const gen = workstation.gen;
      const valid = () => this.attempt === attempt && this.orderKey === orderKey && clientScreenAllowed(this.deps.env.readWorkstation(), gen);
      const claim = () => {
        this.pending?.stopWait();
        this.pending = null;
        if (!valid()) {
          this.stopLocal('disabled');
          return;
        }
        this.apply(publisherClaim(this.state, { disabled: false, gen }, this.deps.env.now(), this.deps.env.randomId()));
      };
      void this.deps.env.locks.query().then((snapshot) => this.guard(() => {
        if (this.attempt !== attempt) return;
        if (!valid()) {
          this.stopLocal('disabled');
          return;
        }
        const viewerOpen = (snapshot.held ?? []).some((lock) => lock.name === CLIENT_SCREEN_VIEWER_LOCK);
        if (viewerOpen) {
          claim();
          return;
        }
        // No customer window yet: open it and claim when it says hello.
        const startedAt = this.deps.env.now();
        const stopWait = this.deps.env.setInterval(() => this.guard(() => {
          if (this.pending?.attempt !== attempt) stopWait();
          else if (!valid()) this.stopLocal('disabled');
          else if (this.deps.env.now() - startedAt > VIEWER_WAIT_MS) this.stopLocal('no-answer');
        }), 500);
        this.pending = { attempt, gen, claim, stopWait };
        this.deps.openWindow();
      })).catch(() => this.guard(() => { throw new Error('client screen: locks query failed'); }));
      this.refresh();
    });
  }

  /** «Скрыть от клиента», also called when the presented order is closed or on logout. */
  hide(orderKey?: string): void {
    this.guard(() => {
      if (orderKey !== undefined && orderKey !== this.orderKey) return;
      this.forget('released');
    });
  }

  /**
   * The presented order changed: send a new snapshot on the next frame. A snapshot that carries a
   * whole-tab copy is large, so after one the next full snapshot goes no sooner than
   * FRAME_PUBLISH_MS later; every change in between is folded into that one send. Blanking and
   * releasing never come through here and are never delayed.
   */
  notifyChanged(orderKey: string): void {
    if (orderKey !== this.orderKey || this.scheduled) return;
    this.scheduled = true;
    const run = () => this.guard(() => {
      const wait = this.frameSentAt === null ? 0 : FRAME_PUBLISH_MS - (this.deps.env.now() - this.frameSentAt);
      if (wait > 0 && wait <= FRAME_PUBLISH_MS) {
        setTimeout(run, wait);
        return;
      }
      this.scheduled = false;
      this.publish();
    });
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  /** Is this code ticked in the settings in force right now? False whenever nothing may be shown. */
  isCodeVisible(code: string): boolean {
    if (this.state.phase !== 'owner' || !this.state.policy) return false;
    if (!publisherCanPublish(this.state, this.deps.env.readWorkstation(), this.deps.env.now())) return false;
    return this.state.policy.visibleCodes.includes(code);
  }

  /** Only the interface state changed (tab, focus, scroll, the row being edited). */
  notifyUi(orderKey: string): void {
    this.guard(() => {
      if (orderKey !== this.orderKey || this.blanked) return;
      if (!publisherCanPublish(this.state, this.deps.env.readWorkstation(), this.deps.env.now())) return;
      this.sendUi();
    });
  }

  /** Emergency switch-off of the whole workstation (button, or an error in this module). */
  async disableWorkstation(): Promise<void> {
    try {
      await this.deps.env.updateWorkstation('disable');
      this.send(clientScreenMessage('shutdown', {}));
      // A customer window of an earlier build reads the same record; its own closing message speeds that up.
      this.deps.env.retireOldViewers();
    } finally {
      // Local cleanup never depends on the channel or the storage.
      this.forget('disabled');
    }
  }

  async enableWorkstation(): Promise<void> {
    await this.deps.env.updateWorkstation('enable');
    this.state = { ...this.state, lost: null };
    this.refresh();
  }

  dispose(): void {
    this.forget('released');
    this.stops.forEach((stop) => stop());
    try {
      this.channel?.close();
    } catch {
      // nothing to do
    }
  }

  /** Re-reads the settings; answers are applied monotonically, a failure is simply not applied. */
  async reloadPolicy(): Promise<void> {
    if (this.state.phase !== 'owner') return;
    const epoch = this.state.epoch;
    const requestSeq = ++this.requestSeq;
    const requestedAt = this.deps.env.now();
    this.lastPolicyAt = requestedAt;
    let policy: ClientScreenPolicy;
    try {
      policy = await this.deps.loadPolicy();
    } catch {
      return;
    }
    this.guard(() => {
      // An answer for a presentation that is over is ignored.
      if (this.state.phase !== 'owner' || this.state.epoch !== epoch) return;
      const result = publisherApplyPolicy(this.state, { requestSeq, requestedAt, policy });
      if (!result.applied) return;
      this.state = result.state;
      if (!policy.enabled) {
        // The organisation switched the customer screen off: stop and release.
        this.forget('policy');
        return;
      }
      // Every confirmed re-read sends a fresh snapshot (at once, not frame-throttled), then the
      // confirmation. The manager window cannot know whether the customer window already blanked by
      // its own clock or missed an earlier message, so it never relies on a confirmation alone.
      this.publish();
      const confirm = publisherConfirm(this.state);
      if (confirm) this.send(confirm);
      this.refresh();
    });
  }

  // ---- internals ----

  private onMessage(message: ClientScreenMessage): void {
    if (message.t === 'shutdown') this.cancelPending();
    if (message.t === 'hello' && this.pending) {
      this.pending.claim();
      return;
    }
    const before = this.state;
    this.apply(publisherOnMessage(this.state, message, this.deps.env.readWorkstation(), this.deps.env.now(), () => this.deps.env.randomId()));
    if (this.state.phase === 'granted' && this.lockedEpoch !== this.state.epoch) this.takeLock(this.state.epoch);
    if (before.phase !== 'idle' && this.state.phase === 'idle') this.afterLoss();
  }

  private takeLock(epoch: number): void {
    this.releaseLock();
    this.lockedEpoch = epoch;
    // Nothing of this epoch is on the customer screen yet: the first confirmed policy publishes.
    this.blanked = true;
    this.lastSnapshot = null;
    this.setPreview(null);
    void this.deps.env.locks.request(clientScreenOwnerLock(epoch), {}, () => {
      if (this.lockedEpoch !== epoch || this.state.epoch !== epoch) return undefined;
      const held = new Promise<void>((resolve) => { this.releaseOwnerLock = resolve; });
      this.guard(() => {
        // Confirmed from inside the held lock; only now the customer window starts to watch it.
        this.apply(publisherOnLockHeld(this.state, epoch));
        void this.reloadPolicy();
      });
      return held;
    }).catch(() => undefined);
  }

  /**
   * Whether another window holds an owner lock — of this build or of any other: the app header of
   * every window shows the emergency switch-off while an order is presented from any of them.
   * Read-only; a failure means "unknown".
   */
  private lookElsewhere(): void {
    const now = this.deps.env.now();
    if (now - this.elsewhereCheckedAt < ELSEWHERE_CHECK_MS) return;
    this.elsewhereCheckedAt = now;
    const mine = this.lockedEpoch ? clientScreenOwnerLock(this.lockedEpoch) : null;
    void this.deps.env.locks.query().then((snapshot) => {
      const next = (snapshot.held ?? []).some((lock) => typeof lock.name === 'string'
        && lock.name.startsWith(CLIENT_SCREEN_ANY_OWNER_LOCK_PREFIX) && lock.name !== mine);
      if (next === this.elsewhere) return;
      this.elsewhere = next;
      this.refresh();
    }).catch(() => undefined);
  }

  private releaseLock(): void {
    this.lockedEpoch = 0;
    this.releaseOwnerLock?.();
    this.releaseOwnerLock = null;
  }

  private tick(): void {
    const workstation = this.deps.env.readWorkstation();
    // A press that is still waiting for the customer window dies with its generation.
    if (this.pending && !clientScreenAllowed(workstation, this.pending.gen)) this.stopLocal('disabled');
    this.lookElsewhere();
    const before = this.state.phase;
    this.apply(publisherTick(this.state, workstation, this.deps.env.now()));
    if (before !== 'idle' && this.state.phase === 'idle') this.afterLoss();
    if (this.state.phase !== 'owner') {
      this.refresh();
      return;
    }
    const now = this.deps.env.now();
    if (now - this.lastPolicyAt >= POLICY_REFRESH_MS) void this.reloadPolicy();
    // Validity ran out (settings unreachable): tell the customer window to blank, once.
    if (!publisherCanPublish(this.state, workstation, now) && !this.blanked) this.publish();
    this.refresh();
  }

  private publish(): void {
    if (this.state.phase !== 'owner' || !this.provider) return;
    const allowed = publisherCanPublish(this.state, this.deps.env.readWorkstation(), this.deps.env.now());
    if (!allowed && (this.blanked || !this.state.policy)) return;
    let snapshot: ClientScreenSnapshot | null = null;
    if (allowed && this.state.policy) {
      this.lastSource = this.provider.getSource();
      const built = buildClientScreenSnapshot(this.lastSource, this.state.policy.visibleCodes, this.idFor);
      // The copy of a whole tab goes only while the customer is on that tab.
      snapshot = built.frame
        ? withShownFrameOnly(built, resolveClientScreenTab(this.provider.getUi(this.idFor).tab, this.lastCustomerTab, built))
        : built;
    }
    this.frameSentAt = snapshot?.frame ? this.deps.env.now() : null;
    const next = publisherState(this.state, snapshot);
    this.state = next.state;
    this.blanked = snapshot === null;
    this.lastSnapshot = snapshot;
    this.send(next.message);
    // A send that failed has ended the presentation and erased everything: nothing is set after it.
    if (this.lastSnapshot !== snapshot || this.state.phase !== 'owner') return;
    if (snapshot) this.sendUi();
    if (this.lastSnapshot !== snapshot || this.state.phase !== 'owner') return;
    // sendUi sets the preview with the interface state; a blank or a state without one is set here.
    if (!snapshot || this.preview?.snapshot !== snapshot) this.setPreview(snapshot ? { snapshot, ui: null } : null);
    this.refresh();
  }

  /** The interface state goes through the same policy as the data, against the snapshot sent last. */
  private sendUi(): void {
    if (!this.provider || !this.lastSnapshot || !this.state.policy) return;
    const raw = this.provider.getUi(this.idFor);
    this.lastRawUi = raw;
    // A tab hidden by the settings, or not mirrored at all, leaves the customer on the last tab shown.
    const tab = resolveClientScreenTab(raw.tab, this.lastCustomerTab, this.lastSnapshot);
    this.lastCustomerTab = tab;
    const ui = filterClientScreenUi({ ...raw, tab }, this.lastSnapshot, this.state.policy.visibleCodes);
    const message = publisherUi(this.state, ui);
    if (message) this.send(message);
    // The preview is what was delivered: after a failed send the presentation is over and it stays empty.
    if (!this.lastSnapshot || this.state.phase !== 'owner') return;
    this.setPreview({ snapshot: this.lastSnapshot, ui });
  }

  private setPreview(next: ClientScreenPreview | null): void {
    if (next === null && this.preview === null) return;
    this.preview = next;
    this.previewListeners.forEach((listener) => {
      try {
        listener();
      } catch {
        // a listener of the header must not break the presenter
      }
    });
  }

  /** Best effort: a broken channel ends the presentation locally instead of throwing. */
  private send(message: ClientScreenMessage): boolean {
    try {
      if (!this.channel) return false;
      this.channel.post(message);
      return true;
    } catch {
      if (message.t !== 'release' && message.t !== 'shutdown') {
        // A channel that cannot send is an error of this module: stop here and switch the workstation off.
        this.stopLocal('error');
        void this.deps.env.updateWorkstation('disable').catch(() => undefined).then(() => {
          this.state = { ...this.state, lost: 'error' };
          this.refresh();
        });
      }
      return false;
    }
  }

  private apply(step: { state: PublisherState; send: ClientScreenMessage[] }): void {
    this.state = step.state;
    for (const message of step.send) this.send(message);
    this.refresh();
  }

  private cancelPending(): void {
    this.pending?.stopWait();
    this.pending = null;
  }

  /** Everything this window holds for a presentation is dropped; never throws, sends nothing. */
  private afterLoss(): void {
    this.cancelPending();
    this.frameSentAt = null;
    this.attempt += 1;
    this.releaseLock();
    this.provider = null;
    this.orderKey = null;
    this.lastSnapshot = null;
    this.lastCustomerTab = null;
    this.lastSource = null;
    this.lastRawUi = null;
    this.blanked = false;
    this.setPreview(null);
    this.refresh();
  }

  /** Stops locally without telling anyone (the channel may be the thing that failed). */
  private stopLocal(reason: PublisherLoss): void {
    this.state = publisherRelease(this.state, reason).state;
    this.afterLoss();
  }

  /** Stops and tells the customer window, best effort; the local cleanup always happens. */
  private forget(reason: PublisherLoss): void {
    const step = publisherRelease(this.state, reason);
    this.state = step.state;
    try {
      for (const message of step.send) this.send(message);
    } finally {
      this.afterLoss();
    }
  }

  private computeView(): ClientScreenPresenterView {
    let workstationDisabled = true;
    try {
      workstationDisabled = this.deps.env.readWorkstation().disabled;
    } catch {
      // keep "disabled"
    }
    return {
      phase: this.state.phase,
      presentedOrderKey: this.orderKey,
      lost: this.state.lost,
      workstationDisabled,
      policyStale: this.state.phase === 'owner' && this.blanked,
      presentingElsewhere: this.elsewhere,
    };
  }

  private refresh(): void {
    const next = this.computeView();
    const same = (Object.keys(next) as Array<keyof ClientScreenPresenterView>).every((key) => next[key] === this.view[key]);
    if (same) return;
    this.view = next;
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        // a listener of the order form must not break the presenter
      }
    });
  }

  /** Nothing thrown here may reach the order form: an error switches the workstation off. */
  private guard(action: () => void): void {
    try {
      action();
    } catch {
      this.stopLocal('error');
      void this.disableWorkstation().catch(() => undefined).then(() => {
        this.state = { ...this.state, lost: 'error' };
        this.refresh();
      });
    }
  }
}

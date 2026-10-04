import { clientScreenMessage, type ClientScreenMessage } from './clientScreenProtocol';
import type { ClientScreenSnapshot, ClientScreenUi } from './clientScreenSnapshotSchema';
import { clientScreenAllowed, type ClientScreenWorkstation } from './clientScreenWorkstation';

/**
 * The customer window is the only arbiter of who presents. This module is its whole decision logic
 * as a pure function: state + event → state + messages to send + effects to run. Claims are handled
 * one at a time in the order they arrive; the owner is the receiver of the latest grant; nothing of
 * another epoch, another generation or an unconfirmed owner is ever shown.
 */
export const OWNER_READY_TIMEOUT_MS = 5000;

export type ViewerScreen = 'splash' | 'order' | 'disabled';

export interface ViewerState {
  viewerId: string;
  /** Last epoch issued by this window in any run it knows of; never decreases. */
  epoch: number;
  owner: { id: string; epoch: number; gen: number; ready: boolean; grantedAt: number } | null;
  /** Recovery after a restart is open only until the first grant of this run. */
  recoveryOpen: boolean;
  shown: { seq: number; policyVersion: number; validUntil: number; snapshot: ClientScreenSnapshot } | null;
  /** Highest seq and policy version received from the current owner; older ones are dropped. */
  lastSeq: number;
  minPolicyVersion: number;
  ui: ClientScreenUi | null;
  screen: ViewerScreen;
}

export type ViewerEvent =
  | { type: 'message'; message: ClientScreenMessage; now: number; workstation: ClientScreenWorkstation }
  /** The lock of the owner of `epoch` was granted to this window: that owner is gone. */
  | { type: 'ownerLockAcquired'; epoch: number }
  | { type: 'tick'; now: number }
  | { type: 'workstation'; workstation: ClientScreenWorkstation; previousGen: number };

export type ViewerEffect =
  | { type: 'watchOwner'; epoch: number }
  | { type: 'cancelWatch' }
  | { type: 'close' };

export interface ViewerStep {
  state: ViewerState;
  send: ClientScreenMessage[];
  effects: ViewerEffect[];
}

export function createViewerState(viewerId: string, workstation: ClientScreenWorkstation): ViewerState {
  return {
    viewerId, epoch: 0, owner: null, recoveryOpen: true, shown: null, lastSeq: 0, minPolicyVersion: 0, ui: null,
    screen: workstation.disabled ? 'disabled' : 'splash',
  };
}

const keep = (state: ViewerState): ViewerStep => ({ state, send: [], effects: [] });

function blank(state: ViewerState, screen: ViewerScreen = 'splash'): ViewerState {
  return { ...state, shown: null, ui: null, screen };
}

/** No owner any more: nothing is shown and nothing of the old epoch will be accepted. */
function dropOwner(state: ViewerState, screen: ViewerScreen = 'splash'): ViewerStep {
  return {
    state: { ...blank(state, screen), owner: null, lastSeq: 0, minPolicyVersion: 0 },
    send: [],
    effects: state.owner ? [{ type: 'cancelWatch' }] : [],
  };
}

function grant(state: ViewerState, candidateId: string, claimId: string, gen: number, now: number): ViewerStep {
  const epoch = Math.max(now, state.epoch + 1);
  return {
    state: {
      ...blank(state),
      epoch,
      owner: { id: candidateId, epoch, gen, ready: false, grantedAt: now },
      recoveryOpen: false,
      lastSeq: 0,
      minPolicyVersion: 0,
    },
    send: [clientScreenMessage('grant', { epoch, ownerId: candidateId, claimId, viewerId: state.viewerId })],
    effects: state.owner ? [{ type: 'cancelWatch' }] : [],
  };
}

export function viewerReduce(state: ViewerState, event: ViewerEvent): ViewerStep {
  if (event.type === 'workstation') {
    if (event.workstation.disabled) {
      const step = dropOwner(state, 'disabled');
      return { ...step, effects: [...step.effects, { type: 'close' }] };
    }
    // Re-enabled, or a generation this window has not seen: whatever was shown belongs to the past.
    if (state.screen === 'disabled' || event.workstation.gen !== event.previousGen) return dropOwner(state, 'splash');
    return keep(state);
  }

  if (event.type === 'ownerLockAcquired') {
    return state.owner && state.owner.epoch === event.epoch ? dropOwner(state) : keep(state);
  }

  if (event.type === 'tick') {
    if (state.owner && !state.owner.ready && event.now - state.owner.grantedAt > OWNER_READY_TIMEOUT_MS) return dropOwner(state);
    if (state.shown && event.now >= state.shown.validUntil) return keep(blank(state));
    return keep(state);
  }

  const { message, now, workstation } = event;
  if (message.t === 'shutdown' || workstation.disabled) {
    const step = dropOwner(state, 'disabled');
    return { ...step, effects: [...step.effects, { type: 'close' }] };
  }

  switch (message.t) {
    case 'claim':
      return clientScreenAllowed(workstation, message.gen) ? grant(state, message.candidateId, message.claimId, message.gen, now) : keep(state);

    case 'resume':
      // Recovery never displaces a presentation started in this run, and answers only this run's hello.
      if (!state.recoveryOpen || message.viewerId !== state.viewerId || !clientScreenAllowed(workstation, message.gen)) return keep(state);
      return grant({ ...state, epoch: Math.max(state.epoch, message.resumeEpoch) }, message.candidateId, message.claimId, message.gen, now);

    case 'hello':
    case 'grant':
      return keep(state);

    default:
      break;
  }

  // Everything below comes from an owner: it must be the current one, of the current generation.
  const owner = state.owner;
  if (!owner || message.epoch !== owner.epoch || message.gen !== owner.gen || !clientScreenAllowed(workstation, message.gen)) return keep(state);

  if (message.t === 'owner-ready') {
    if (owner.ready) return keep(state);
    return { state: { ...state, owner: { ...owner, ready: true } }, send: [], effects: [{ type: 'watchOwner', epoch: owner.epoch }] };
  }
  if (!owner.ready) return keep(state);

  switch (message.t) {
    case 'release':
      return dropOwner(state);

    case 'state': {
      if (message.seq <= state.lastSeq || message.policyVersion < state.minPolicyVersion) return keep(state);
      const next = { ...state, lastSeq: message.seq, minPolicyVersion: message.policyVersion };
      if (message.mode === 'blank' || message.snapshot === null || message.validUntil <= now) return keep(blank(next));
      return keep({
        ...next,
        shown: { seq: message.seq, policyVersion: message.policyVersion, validUntil: message.validUntil, snapshot: message.snapshot },
        // A new snapshot drops the overlays; the owner repeats the current ui right after it.
        ui: null,
        screen: 'order',
      });
    }

    case 'ui':
      return state.shown && message.stateSeq === state.shown.seq ? keep({ ...state, ui: message.ui }) : keep(state);

    case 'confirm': {
      if (message.policyVersion < state.minPolicyVersion) return keep(state);
      const next = { ...state, minPolicyVersion: message.policyVersion };
      if (!next.shown) return keep(next);
      // A confirmation of a newer policy must not prolong a snapshot built under the older one.
      if (message.policyVersion > next.shown.policyVersion) return keep(blank(next));
      if (message.validUntil <= next.shown.validUntil) return keep(next);
      return keep({ ...next, shown: { ...next.shown, validUntil: message.validUntil } });
    }

    default:
      return keep(state);
  }
}

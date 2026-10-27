import { clientScreenMessage, type ClientScreenMessage, type ClientScreenMessageOf } from './clientScreenProtocol';
import type { ClientScreenSnapshot, ClientScreenUi } from './clientScreenSnapshotSchema';
import { clientScreenAllowed, type ClientScreenWorkstation } from './clientScreenWorkstation';

/**
 * Decision logic of a manager window, pure. A window presents only between a grant in its own name
 * (confirmed with `owner-ready` from inside its held lock) and the first sign that it lost the
 * presentation: a grant for another window, a new workstation generation, a switch-off, a release.
 * Losing is final: the only way back is a new claim made by the manager.
 */
export const POLICY_VALID_MS = 60_000;
export const POLICY_REFRESH_MS = 20_000;
export const CLAIM_TIMEOUT_MS = 5000;

export type PublisherPhase = 'idle' | 'claiming' | 'granted' | 'owner';
export type PublisherLoss = 'taken' | 'disabled' | 'no-answer' | 'released' | 'policy' | 'error';

export interface ClientScreenPolicy {
  enabled: boolean;
  visibleCodes: readonly string[];
  version: number;
}

export interface PublisherState {
  windowId: string;
  phase: PublisherPhase;
  gen: number;
  /** Id of the pending claim: only the grant that answers it makes this window the owner. */
  claimId: string;
  /** Highest epoch granted to another window while this claim was pending. */
  foreignEpoch: number;
  claimedAt: number;
  epoch: number;
  /** Last epoch this window owned, offered when the customer window restarts. */
  lastEpoch: number;
  seq: number;
  /** Why the window stopped presenting; shown to the manager. */
  lost: PublisherLoss | null;
  policy: ClientScreenPolicy | null;
  /** Start time of the settings request the policy came from: validity counts from it. */
  policyRequestedAt: number;
  /** Number of the newest settings request whose answer was applied. */
  policyRequestSeq: number;
}

export interface PublisherStep {
  state: PublisherState;
  send: ClientScreenMessage[];
}

export function createPublisherState(windowId: string): PublisherState {
  return {
    windowId, phase: 'idle', gen: 0, claimId: '', foreignEpoch: 0, claimedAt: 0, epoch: 0, lastEpoch: 0, seq: 0, lost: null,
    policy: null, policyRequestedAt: 0, policyRequestSeq: 0,
  };
}

const idle = (state: PublisherState, lost: PublisherLoss | null): PublisherState =>
  ({ ...state, phase: 'idle', epoch: 0, seq: 0, lost, lastEpoch: lost === 'taken' || lost === 'disabled' ? 0 : state.lastEpoch });

/** «Показать клиенту»: the claim goes out at once, before the settings are loaded. */
export function publisherClaim(state: PublisherState, workstation: ClientScreenWorkstation, now: number, claimId: string): PublisherStep {
  if (workstation.disabled) return { state: idle(state, 'disabled'), send: [] };
  return {
    state: {
      ...state, phase: 'claiming', gen: workstation.gen, claimId, foreignEpoch: 0, claimedAt: now, epoch: 0, seq: 0, lost: null,
      policy: null, policyRequestedAt: 0,
    },
    send: [clientScreenMessage('claim', { candidateId: state.windowId, claimId, gen: workstation.gen })],
  };
}

export function publisherOnMessage(
  state: PublisherState, message: ClientScreenMessage, workstation: ClientScreenWorkstation, now: number, newClaimId: () => string,
): PublisherStep {
  if (message.t === 'shutdown') return { state: state.phase === 'idle' ? state : idle(state, 'disabled'), send: [] };

  if (message.t === 'grant') {
    if (message.ownerId !== state.windowId) {
      if (state.phase === 'idle') return { state: { ...state, lastEpoch: 0 }, send: [] };
      // While this window's claim is still unanswered a grant for another window proves nothing:
      // the customer window may handle this claim later. It is only remembered.
      if (state.phase === 'claiming') return { state: { ...state, foreignEpoch: Math.max(state.foreignEpoch, message.epoch) }, send: [] };
      // Presenting (or about to): a newer grant for someone else ends it for good.
      return message.epoch > state.epoch ? { state: idle(state, 'taken'), send: [] } : { state, send: [] };
    }
    // Only the grant that answers the pending claim counts; grants of earlier claims are ignored.
    if (state.phase !== 'claiming' || message.claimId !== state.claimId || !clientScreenAllowed(workstation, state.gen)) return { state, send: [] };
    // Granted before a grant that another window already got: that window is the latest owner.
    if (message.epoch < state.foreignEpoch) return { state: idle(state, 'taken'), send: [] };
    return { state: { ...state, phase: 'granted', epoch: message.epoch, lastEpoch: message.epoch, seq: 0 }, send: [] };
  }

  if (message.t === 'hello') {
    // The customer window restarted: offer to continue, the customer window decides.
    if (state.phase !== 'owner' || workstation.disabled || workstation.gen !== state.gen) return { state, send: [] };
    const claimId = newClaimId();
    return {
      state: { ...state, phase: 'claiming', claimId, foreignEpoch: 0, claimedAt: now, epoch: 0, seq: 0 },
      send: [clientScreenMessage('resume', {
        candidateId: state.windowId, claimId, gen: state.gen, viewerId: message.viewerId, resumeEpoch: state.lastEpoch,
      })],
    };
  }
  return { state, send: [] };
}

/** Called from inside the held owner lock: only now the window may publish. */
export function publisherOnLockHeld(state: PublisherState, epoch: number): PublisherStep {
  if (state.phase !== 'granted' || state.epoch !== epoch) return { state, send: [] };
  return { state: { ...state, phase: 'owner' }, send: [clientScreenMessage('owner-ready', { epoch, gen: state.gen })] };
}

export function publisherTick(state: PublisherState, workstation: ClientScreenWorkstation, now: number): PublisherStep {
  if (state.phase !== 'idle' && !clientScreenAllowed(workstation, state.gen)) return { state: idle(state, 'disabled'), send: [] };
  if (state.phase === 'claiming' && now - state.claimedAt > CLAIM_TIMEOUT_MS) return { state: idle(state, 'no-answer'), send: [] };
  return { state, send: [] };
}

/** «Скрыть от клиента», logout, the presented order closed. */
export function publisherRelease(state: PublisherState, reason: PublisherLoss = 'released'): PublisherStep {
  const send = state.phase === 'owner' ? [clientScreenMessage('release', { epoch: state.epoch, gen: state.gen })] : [];
  return { state: { ...idle(state, reason), lastEpoch: 0 }, send };
}

export const publisherValidUntil = (state: PublisherState): number => state.policyRequestedAt + POLICY_VALID_MS;

/** May this window publish a snapshot right now? */
export function publisherCanPublish(state: PublisherState, workstation: ClientScreenWorkstation, now: number): boolean {
  return state.phase === 'owner' && clientScreenAllowed(workstation, state.gen)
    && state.policy !== null && state.policy.enabled && now < publisherValidUntil(state);
}

/**
 * Applies an answer of the settings API. Acceptance is monotonic: an answer is used only if its
 * request started after the last applied one and its version is not lower, so a late answer with an
 * older policy can never bring a hidden field back. A stale answer does not extend the validity.
 */
export function publisherApplyPolicy(
  state: PublisherState,
  answer: { requestSeq: number; requestedAt: number; policy: ClientScreenPolicy },
): { state: PublisherState; applied: boolean; versionChanged: boolean } {
  const stale = answer.requestSeq <= state.policyRequestSeq || (state.policy !== null && answer.policy.version < state.policy.version);
  if (stale) return { state, applied: false, versionChanged: false };
  const versionChanged = state.policy === null || state.policy.version !== answer.policy.version;
  return {
    state: { ...state, policy: answer.policy, policyRequestedAt: answer.requestedAt, policyRequestSeq: answer.requestSeq },
    applied: true,
    versionChanged,
  };
}

/** Next `state` message: a snapshot, or a blank when there is nothing the customer may see. */
export function publisherState(state: PublisherState, snapshot: ClientScreenSnapshot | null): { state: PublisherState; message: ClientScreenMessageOf<'state'> } {
  const seq = state.seq + 1;
  return {
    state: { ...state, seq },
    message: clientScreenMessage('state', {
      epoch: state.epoch, gen: state.gen, seq, policyVersion: state.policy?.version ?? 1, validUntil: publisherValidUntil(state),
      mode: snapshot ? 'order' : 'blank', snapshot,
    }),
  };
}

/** `ui` always refers to the snapshot that was sent last. */
export function publisherUi(state: PublisherState, ui: ClientScreenUi): ClientScreenMessageOf<'ui'> | null {
  if (state.seq === 0) return null;
  return clientScreenMessage('ui', { epoch: state.epoch, gen: state.gen, stateSeq: state.seq, ui });
}

export function publisherConfirm(state: PublisherState): ClientScreenMessageOf<'confirm'> | null {
  if (state.phase !== 'owner' || !state.policy) return null;
  return clientScreenMessage('confirm', { epoch: state.epoch, gen: state.gen, policyVersion: state.policy.version, validUntil: publisherValidUntil(state) });
}

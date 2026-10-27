import { describe, expect, it } from 'vitest';
import { createViewerState, OWNER_READY_TIMEOUT_MS, viewerReduce, type ViewerState, type ViewerStep } from './clientScreenArbiter';
import { clientScreenMessage, type ClientScreenMessage } from './clientScreenProtocol';
import { snapshot, ui } from './clientScreenProtocol.test';
import type { ClientScreenWorkstation } from './clientScreenWorkstation';

const V = 'viewervvvvvvvvvv';
const A = 'windowaaaaaaaaaa';
const B = 'windowbbbbbbbbbb';
const on: ClientScreenWorkstation = { disabled: false, gen: 0 };
const T0 = 1_000_000;

/** Runs messages through the arbiter, keeping the last step. */
function run(start: ViewerState, messages: Array<[ClientScreenMessage, number?, ClientScreenWorkstation?]>): ViewerStep {
  let step: ViewerStep = { state: start, send: [], effects: [] };
  for (const [message, now = T0, workstation = on] of messages) step = viewerReduce(step.state, { type: 'message', message, now, workstation });
  return step;
}
const CLAIM = 'claimcccccccccccc';
const claim = (id: string, gen = 0, claimId = CLAIM) => clientScreenMessage('claim', { candidateId: id, claimId, gen });
const ready = (epoch: number, gen = 0) => clientScreenMessage('owner-ready', { epoch, gen });
const state = (epoch: number, seq: number, over: Partial<{ policyVersion: number; validUntil: number; gen: number; blank: boolean }> = {}) =>
  clientScreenMessage('state', {
    epoch, gen: over.gen ?? 0, seq, policyVersion: over.policyVersion ?? 10, validUntil: over.validUntil ?? T0 + 60_000,
    mode: over.blank ? 'blank' : 'order', snapshot: over.blank ? null : snapshot,
  });

/** A owns and shows a snapshot. */
function presenting(): { state: ViewerState; epoch: number } {
  const granted = run(createViewerState(V, on), [[claim(A)]]);
  const epoch = granted.state.epoch;
  return { state: run(granted.state, [[ready(epoch)], [state(epoch, 1)]]).state, epoch };
}

describe('customer window arbiter', () => {
  it('starts on the splash, or disabled when the workstation is switched off', () => {
    expect(createViewerState(V, on).screen).toBe('splash');
    expect(createViewerState(V, { disabled: true, gen: 1 }).screen).toBe('disabled');
  });

  it('grants a claim, shows nothing until owner-ready, then watches the owner lock and shows the snapshot', () => {
    const granted = run(createViewerState(V, on), [[claim(A)]]);
    const epoch = granted.state.epoch;
    expect(granted.send).toEqual([clientScreenMessage('grant', { epoch, ownerId: A, claimId: CLAIM, viewerId: V })]);
    // A snapshot before owner-ready is not shown.
    expect(run(granted.state, [[state(epoch, 1)]]).state.screen).toBe('splash');
    const confirmed = run(granted.state, [[ready(epoch)]]);
    expect(confirmed.effects).toEqual([{ type: 'watchOwner', epoch }]);
    const shown = run(confirmed.state, [[state(epoch, 1)], [clientScreenMessage('ui', { epoch, gen: 0, stateSeq: 1, ui })]]);
    expect(shown.state).toMatchObject({ screen: 'order', shown: { seq: 1, snapshot }, ui });
  });

  it('a grant that is handled late by the owner does not make the window think the owner is gone', () => {
    const granted = run(createViewerState(V, on), [[claim(A)]]);
    // No lock is watched before owner-ready, so nothing can report "owner gone" for this epoch yet.
    expect(granted.effects).toEqual([]);
    expect(viewerReduce(granted.state, { type: 'tick', now: T0 + OWNER_READY_TIMEOUT_MS - 1 }).state.owner).not.toBeNull();
    const late = viewerReduce(granted.state, { type: 'tick', now: T0 + OWNER_READY_TIMEOUT_MS + 1 });
    expect(late.state.owner).toBeNull();
    // The voided epoch is dead: its owner-ready and snapshots are ignored.
    expect(run(late.state, [[ready(granted.state.epoch)], [state(granted.state.epoch, 1)]]).state.screen).toBe('splash');
  });

  it('the later claim wins; late messages of the earlier owner are dropped in any order and cannot stop the new one', () => {
    const { state: a, epoch: epochA } = presenting();
    const taken = run(a, [[claim(B), T0 + 10]]);
    const epochB = taken.state.epoch;
    expect(epochB).toBeGreaterThan(epochA);
    expect(taken.state).toMatchObject({ screen: 'splash', shown: null, ui: null, owner: { id: B, ready: false } });
    expect(taken.effects).toEqual([{ type: 'cancelWatch' }]);
    const b = run(taken.state, [[ready(epochB), T0 + 11], [state(epochB, 1), T0 + 12]]);
    const afterLate = run(b.state, [
      [state(epochA, 2), T0 + 13], [clientScreenMessage('ui', { epoch: epochA, gen: 0, stateSeq: 1, ui }), T0 + 13],
      [clientScreenMessage('release', { epoch: epochA, gen: 0 }), T0 + 13], [ready(epochA), T0 + 13],
      [clientScreenMessage('confirm', { epoch: epochA, gen: 0, policyVersion: 99, validUntil: T0 + 999_999 }), T0 + 13],
    ]);
    expect(afterLate.state).toEqual(b.state);
    // The old owner's lock released late: it is not the current epoch, nothing changes.
    expect(viewerReduce(b.state, { type: 'ownerLockAcquired', epoch: epochA }).state).toEqual(b.state);
  });

  it('a slow candidate A whose claim arrived first loses to B that claimed later, even if A becomes ready afterwards', () => {
    const afterA = run(createViewerState(V, on), [[claim(A), T0]]);
    const afterB = run(afterA.state, [[claim(B), T0 + 5]]);
    const epochB = afterB.state.epoch;
    const b = run(afterB.state, [[ready(epochB), T0 + 6], [state(epochB, 1), T0 + 7]]);
    const lateA = run(b.state, [[ready(afterA.state.epoch), T0 + 900], [state(afterA.state.epoch, 1), T0 + 901]]);
    expect(lateA.state).toEqual(b.state);
  });

  it('epochs never decrease, also when the clock does not move or goes back', () => {
    const first = run(createViewerState(V, on), [[claim(A), T0]]);
    const second = run(first.state, [[claim(B), T0]]);
    const third = run(second.state, [[claim(A), T0 - 5000]]);
    expect(second.state.epoch).toBe(first.state.epoch + 1);
    expect(third.state.epoch).toBe(second.state.epoch + 1);
  });

  it('the owner closing (its lock comes to this window) blanks the screen; only a new claim brings an order back', () => {
    const { state: a, epoch } = presenting();
    const gone = viewerReduce(a, { type: 'ownerLockAcquired', epoch });
    expect(gone.state).toMatchObject({ screen: 'splash', owner: null, shown: null });
    expect(run(gone.state, [[state(epoch, 2)], [ready(epoch)]]).state.screen).toBe('splash');
  });

  it('release and a blank state show the splash', () => {
    const { state: a, epoch } = presenting();
    expect(run(a, [[clientScreenMessage('release', { epoch, gen: 0 })]]).state).toMatchObject({ screen: 'splash', owner: null });
    const blanked = run(a, [[state(epoch, 2, { blank: true })]]);
    expect(blanked.state).toMatchObject({ screen: 'splash', shown: null });
    expect(blanked.state.owner).not.toBeNull();
  });

  it('drops a snapshot that is not newer and a ui that refers to another snapshot; a new snapshot clears the overlays', () => {
    const { state: a, epoch } = presenting();
    const withUi = run(a, [[clientScreenMessage('ui', { epoch, gen: 0, stateSeq: 1, ui })]]);
    expect(run(withUi.state, [[state(epoch, 1)]]).state).toEqual(withUi.state);
    expect(run(withUi.state, [[clientScreenMessage('ui', { epoch, gen: 0, stateSeq: 7, ui: { ...ui, tab: 'basic' } })]]).state.ui).toEqual(ui);
    const next = run(withUi.state, [[state(epoch, 2)]]);
    expect(next.state).toMatchObject({ shown: { seq: 2 }, ui: null });
    // The ui of the previous snapshot arriving late does not attach to the new one.
    expect(run(next.state, [[clientScreenMessage('ui', { epoch, gen: 0, stateSeq: 1, ui })]]).state.ui).toBeNull();
  });

  it('blanks by itself when the policy validity passes; only a confirmation of the shown version extends it', () => {
    const { state: a, epoch } = presenting();
    expect(viewerReduce(a, { type: 'tick', now: T0 + 59_999 }).state.screen).toBe('order');
    expect(viewerReduce(a, { type: 'tick', now: T0 + 60_000 }).state.screen).toBe('splash');
    const extended = run(a, [[clientScreenMessage('confirm', { epoch, gen: 0, policyVersion: 10, validUntil: T0 + 80_000 }), T0 + 20_000]]);
    expect(viewerReduce(extended.state, { type: 'tick', now: T0 + 70_000 }).state.screen).toBe('order');
    // state and ui messages do not extend the validity by themselves: validity comes from the message field only.
    const sameValidity = run(a, [[state(epoch, 2, { validUntil: T0 + 60_000 }), T0 + 50_000]]);
    expect(viewerReduce(sameValidity.state, { type: 'tick', now: T0 + 60_000 }).state.screen).toBe('splash');
    // A snapshot that is already expired on arrival is not shown.
    expect(run(a, [[state(epoch, 2, { validUntil: T0 + 10 }), T0 + 20]]).state.screen).toBe('splash');
  });

  it('a confirmation of a newer policy blanks the old snapshot; repeated confirmations do not keep it; old-policy messages are dropped', () => {
    const { state: a, epoch } = presenting();
    const confirmedNew = run(a, [[clientScreenMessage('confirm', { epoch, gen: 0, policyVersion: 11, validUntil: T0 + 90_000 }), T0 + 1000]]);
    expect(confirmedNew.state).toMatchObject({ screen: 'splash', shown: null });
    const again = run(confirmedNew.state, [
      [clientScreenMessage('confirm', { epoch, gen: 0, policyVersion: 11, validUntil: T0 + 120_000 }), T0 + 2000],
      [state(epoch, 2, { policyVersion: 10 }), T0 + 2001],
    ]);
    expect(again.state.screen).toBe('splash');
    const fresh = run(again.state, [[state(epoch, 3, { policyVersion: 11, validUntil: T0 + 120_000 }), T0 + 2002]]);
    expect(fresh.state).toMatchObject({ screen: 'order', shown: { policyVersion: 11 } });
    // A late confirmation of the older policy cannot extend anything.
    expect(run(fresh.state, [[clientScreenMessage('confirm', { epoch, gen: 0, policyVersion: 10, validUntil: T0 + 999_999 }), T0 + 2003]]).state).toEqual(fresh.state);
  });

  it('after a restart: resume is accepted only for this run and only until the first grant; an explicit claim always wins', () => {
    const fresh = createViewerState(V, on);
    const resume = (id: string, resumeEpoch: number, viewerId = V) => clientScreenMessage('resume', { candidateId: id, claimId: CLAIM, gen: 0, viewerId, resumeEpoch });
    expect(run(fresh, [[resume(A, 500, 'viewerotherxxxxx')]]).state.owner).toBeNull();
    const resumed = run(fresh, [[resume(A, T0 + 777_777)]]);
    expect(resumed.state.owner?.id).toBe(A);
    expect(resumed.state.epoch).toBeGreaterThan(T0 + 777_777);
    // New explicit presentation B, then a delayed resume of A: B stays the owner.
    const b = run(fresh, [[claim(B), T0]]);
    const afterLateResume = run(b.state, [[resume(A, 999), T0 + 50]]);
    expect(afterLateResume.state).toEqual(b.state);
    expect(afterLateResume.send).toEqual([]);
    // A second resume after an accepted one is rejected too.
    expect(run(resumed.state, [[resume(B, T0 + 999_999)]]).state.owner?.id).toBe(A);
  });

  it('switch-off closes the window and voids everything; after re-enabling nothing of the old generation comes back', () => {
    const { state: a, epoch } = presenting();
    const off: ClientScreenWorkstation = { disabled: true, gen: 1 };
    const byMessage = run(a, [[clientScreenMessage('shutdown', {})]]);
    expect(byMessage.state).toMatchObject({ screen: 'disabled', owner: null, shown: null, ui: null });
    expect(byMessage.effects).toEqual([{ type: 'cancelWatch' }, { type: 'close' }]);
    const byStorage = viewerReduce(a, { type: 'workstation', workstation: off, previousGen: 0 });
    expect(byStorage.state.screen).toBe('disabled');
    // Any message that arrives while the record says "disabled" is treated the same way.
    expect(run(a, [[state(epoch, 2), T0, off]]).state.screen).toBe('disabled');
    expect(run(byStorage.state, [[claim(B, 1), T0, off]]).send).toEqual([]);

    const enabled: ClientScreenWorkstation = { disabled: false, gen: 1 };
    const back = viewerReduce(byStorage.state, { type: 'workstation', workstation: enabled, previousGen: 1 });
    expect(back.state).toMatchObject({ screen: 'splash', owner: null });
    const old = run(back.state, [
      [state(epoch, 3), T0, enabled], [ready(epoch), T0, enabled],
      [clientScreenMessage('confirm', { epoch, gen: 0, policyVersion: 10, validUntil: T0 + 999_999 }), T0, enabled],
      [claim(A, 0), T0, enabled], // a claim made before the switch-off
      [clientScreenMessage('resume', { candidateId: A, claimId: CLAIM, gen: 0, viewerId: V, resumeEpoch: epoch }), T0, enabled],
    ]);
    expect(old.state).toEqual(back.state);
    expect(old.send).toEqual([]);
    // Only a claim of the new generation starts a presentation.
    expect(run(back.state, [[claim(A, 1), T0, enabled]]).state.owner?.id).toBe(A);
  });

  it('a claim made while the switch-off was being written (old generation) is refused after re-enabling', () => {
    const enabled: ClientScreenWorkstation = { disabled: false, gen: 3 };
    const fresh = createViewerState(V, enabled);
    expect(run(fresh, [[claim(B, 2), T0, enabled]]).state.owner).toBeNull();
  });

  it('a new generation seen without a switch-off also voids the current presentation', () => {
    const { state: a } = presenting();
    const moved = viewerReduce(a, { type: 'workstation', workstation: { disabled: false, gen: 2 }, previousGen: 0 });
    expect(moved.state).toMatchObject({ screen: 'splash', owner: null, shown: null });
  });
});

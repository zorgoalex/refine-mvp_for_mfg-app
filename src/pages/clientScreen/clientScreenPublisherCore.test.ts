import { describe, expect, it } from 'vitest';
import { clientScreenMessage, parseClientScreenMessage } from './clientScreenProtocol';
import { snapshot, ui } from './clientScreenProtocol.test';
import {
  CLAIM_TIMEOUT_MS, POLICY_VALID_MS, createPublisherState, publisherApplyPolicy, publisherCanPublish, publisherClaim, publisherConfirm,
  publisherOnLockHeld, publisherOnMessage, publisherRelease, publisherState, publisherTick, publisherUi, type PublisherState,
} from './clientScreenPublisherCore';
import type { ClientScreenWorkstation } from './clientScreenWorkstation';

const A = 'windowaaaaaaaaaa';
const B = 'windowbbbbbbbbbb';
const V = 'viewervvvvvvvvvv';
const on: ClientScreenWorkstation = { disabled: false, gen: 2 };
const T0 = 5_000_000;
const C1 = 'claimaaaaaaaaaaaa';
const C2 = 'claimbbbbbbbbbbbb';
const newId = () => C2;
const policy = (version: number, enabled = true) => ({ enabled, visibleCodes: ['summary.number'], version });

function owner(): PublisherState {
  let state = publisherClaim(createPublisherState(A), on, T0, C1).state;
  state = publisherOnMessage(state, clientScreenMessage('grant', { epoch: 77, ownerId: A, claimId: C1, viewerId: V }), on, T0 + 1, newId).state;
  state = publisherOnLockHeld(state, 77).state;
  return publisherApplyPolicy(state, { requestSeq: 1, requestedAt: T0, policy: policy(10) }).state;
}

describe('manager window publisher', () => {
  it('claims at once with the generation read at the click; a switched-off workstation cannot claim', () => {
    const step = publisherClaim(createPublisherState(A), on, T0, C1);
    expect(step.send).toEqual([clientScreenMessage('claim', { candidateId: A, claimId: C1, gen: 2 })]);
    expect(step.state).toMatchObject({ phase: 'claiming', gen: 2, lost: null });
    const refused = publisherClaim(createPublisherState(A), { disabled: true, gen: 3 }, T0, C1);
    expect(refused).toMatchObject({ send: [], state: { phase: 'idle', lost: 'disabled' } });
  });

  it('publishes only after its own grant AND owner-ready sent from the held lock', () => {
    const claiming = publisherClaim(createPublisherState(A), on, T0, C1).state;
    expect(publisherCanPublish(claiming, on, T0)).toBe(false);
    const granted = publisherOnMessage(claiming, clientScreenMessage('grant', { epoch: 77, ownerId: A, claimId: C1, viewerId: V }), on, T0, newId).state;
    expect(granted.phase).toBe('granted');
    expect(publisherCanPublish(granted, on, T0)).toBe(false);
    expect(publisherOnLockHeld(granted, 76)).toEqual({ state: granted, send: [] });
    const held = publisherOnLockHeld(granted, 77);
    expect(held.send).toEqual([clientScreenMessage('owner-ready', { epoch: 77, gen: 2 })]);
    // Still nothing to publish until the settings are confirmed.
    expect(publisherCanPublish(held.state, on, T0)).toBe(false);
    expect(publisherCanPublish(owner(), on, T0 + 1000)).toBe(true);
  });

  it('a newer grant for another window ends an ongoing presentation for good', () => {
    const other = clientScreenMessage('grant', { epoch: 90, ownerId: B, claimId: C2, viewerId: V });
    const lost = publisherOnMessage(owner(), other, on, T0 + 5, newId).state;
    expect(lost).toMatchObject({ phase: 'idle', lost: 'taken', epoch: 0, lastEpoch: 0 });
    expect(publisherCanPublish(lost, on, T0 + 6)).toBe(false);
    // Its own stale grant arriving later does not revive it.
    expect(publisherOnMessage(lost, clientScreenMessage('grant', { epoch: 77, ownerId: A, claimId: C1, viewerId: V }), on, T0 + 7, newId).state.phase).toBe('idle');
    // It does not offer to resume after the customer window restarts.
    expect(publisherOnMessage(lost, clientScreenMessage('hello', { viewerId: V }), on, T0 + 8, newId).send).toEqual([]);
    // A grant of an older epoch for someone else (cannot be newer than this presentation) changes nothing.
    const older = clientScreenMessage('grant', { epoch: 50, ownerId: B, claimId: C2, viewerId: V });
    expect(publisherOnMessage(owner(), older, on, T0 + 5, newId).state.phase).toBe('owner');
  });

  it('overlapping claims: a grant for the other window does not cancel a claim that is still unanswered', () => {
    // The customer window handled A then B: it sent grant(A, 80) and grant(B, 81). Both windows see both grants.
    const grantA = clientScreenMessage('grant', { epoch: 80, ownerId: A, claimId: C1, viewerId: V });
    const grantB = clientScreenMessage('grant', { epoch: 81, ownerId: B, claimId: C2, viewerId: V });
    let a = publisherClaim(createPublisherState(A), on, T0, C1).state;
    let b = publisherClaim(createPublisherState(B), on, T0, C2).state;
    a = publisherOnMessage(a, grantA, on, T0 + 1, newId).state;
    b = publisherOnMessage(b, grantA, on, T0 + 1, newId).state;
    expect(a.phase).toBe('granted');
    expect(b).toMatchObject({ phase: 'claiming', foreignEpoch: 80 });
    a = publisherOnMessage(a, grantB, on, T0 + 2, newId).state;
    b = publisherOnMessage(b, grantB, on, T0 + 2, newId).state;
    expect(a).toMatchObject({ phase: 'idle', lost: 'taken' });
    expect(b).toMatchObject({ phase: 'granted', epoch: 81 });
  });

  it('a grant of an earlier claim of the same window is ignored; only the pending claim is answered', () => {
    let a = publisherClaim(createPublisherState(A), on, T0, C1).state;
    a = publisherClaim(a, on, T0 + 10, C2).state; // the button pressed again
    const stale = publisherOnMessage(a, clientScreenMessage('grant', { epoch: 80, ownerId: A, claimId: C1, viewerId: V }), on, T0 + 11, newId).state;
    expect(stale.phase).toBe('claiming');
    const answered = publisherOnMessage(stale, clientScreenMessage('grant', { epoch: 81, ownerId: A, claimId: C2, viewerId: V }), on, T0 + 12, newId).state;
    expect(answered).toMatchObject({ phase: 'granted', epoch: 81 });
  });

  it('an own grant older than a grant already seen for another window means that window is the latest owner', () => {
    let a = publisherClaim(createPublisherState(A), on, T0, C1).state;
    a = publisherOnMessage(a, clientScreenMessage('grant', { epoch: 90, ownerId: B, claimId: C2, viewerId: V }), on, T0 + 1, newId).state;
    a = publisherOnMessage(a, clientScreenMessage('grant', { epoch: 80, ownerId: A, claimId: C1, viewerId: V }), on, T0 + 2, newId).state;
    expect(a).toMatchObject({ phase: 'idle', lost: 'taken' });
  });

  it('no grant within the timeout tells the manager the customer window does not answer', () => {
    const claiming = publisherClaim(createPublisherState(A), on, T0, C1).state;
    expect(publisherTick(claiming, on, T0 + CLAIM_TIMEOUT_MS).state.phase).toBe('claiming');
    expect(publisherTick(claiming, on, T0 + CLAIM_TIMEOUT_MS + 1).state).toMatchObject({ phase: 'idle', lost: 'no-answer' });
  });

  it('the workstation switch-off or a new generation stops every phase; shutdown does the same', () => {
    for (const start of [publisherClaim(createPublisherState(A), on, T0, C1).state, owner()]) {
      expect(publisherTick(start, { disabled: true, gen: 3 }, T0).state).toMatchObject({ phase: 'idle', lost: 'disabled' });
      expect(publisherTick(start, { disabled: false, gen: 3 }, T0).state).toMatchObject({ phase: 'idle', lost: 'disabled' });
      expect(publisherOnMessage(start, clientScreenMessage('shutdown', {}), on, T0, newId).state).toMatchObject({ phase: 'idle', lost: 'disabled' });
      expect(publisherCanPublish(start, { disabled: false, gen: 3 }, T0)).toBe(false);
    }
  });

  it('a claim made before a switch-off does not become an owner when its grant arrives after re-enabling', () => {
    const claiming = publisherClaim(createPublisherState(A), on, T0, C1).state;
    const enabledAgain: ClientScreenWorkstation = { disabled: false, gen: 3 };
    const late = publisherOnMessage(claiming, clientScreenMessage('grant', { epoch: 77, ownerId: A, claimId: C1, viewerId: V }), enabledAgain, T0 + 10, newId);
    expect(late.state.phase).toBe('claiming');
    expect(publisherTick(late.state, enabledAgain, T0 + 11).state.phase).toBe('idle');
  });

  it('answers the customer window restart with resume and waits for a grant like a claim', () => {
    const step = publisherOnMessage(owner(), clientScreenMessage('hello', { viewerId: 'viewernewxxxxxxx' }), on, T0 + 100, newId);
    expect(step.send).toEqual([clientScreenMessage('resume', { candidateId: A, claimId: C2, gen: 2, viewerId: 'viewernewxxxxxxx', resumeEpoch: 77 })]);
    expect(step.state).toMatchObject({ phase: 'claiming', epoch: 0 });
    expect(publisherCanPublish(step.state, on, T0 + 101)).toBe(false);
    // Refused (no grant): the manager is asked to press the button again.
    expect(publisherTick(step.state, on, T0 + 100 + CLAIM_TIMEOUT_MS + 1).state).toMatchObject({ phase: 'idle', lost: 'no-answer' });
  });

  it('release tells the customer window only when this window owns the presentation', () => {
    expect(publisherRelease(owner()).send).toEqual([clientScreenMessage('release', { epoch: 77, gen: 2 })]);
    expect(publisherRelease(publisherClaim(createPublisherState(A), on, T0, C1).state).send).toEqual([]);
    expect(publisherRelease(owner()).state).toMatchObject({ phase: 'idle', lost: 'released', lastEpoch: 0 });
  });

  it('accepts settings answers monotonically: a late answer of an older request or version changes nothing and extends nothing', () => {
    let state = owner(); // request 1 at T0, version 10
    const newer = publisherApplyPolicy(state, { requestSeq: 3, requestedAt: T0 + 40_000, policy: policy(11) });
    expect(newer).toMatchObject({ applied: true, versionChanged: true });
    state = newer.state;
    // Request 2 started earlier, read version 10 and answered late: ignored, validity unchanged.
    const late = publisherApplyPolicy(state, { requestSeq: 2, requestedAt: T0 + 20_000, policy: policy(10) });
    expect(late).toEqual({ state, applied: false, versionChanged: false });
    // A newer request that somehow reports a lower version is ignored too.
    expect(publisherApplyPolicy(state, { requestSeq: 4, requestedAt: T0 + 50_000, policy: policy(10) }).applied).toBe(false);
    // Same version again: applied, validity moves, version unchanged.
    const same = publisherApplyPolicy(state, { requestSeq: 5, requestedAt: T0 + 60_000, policy: policy(11) });
    expect(same).toMatchObject({ applied: true, versionChanged: false, state: { policyRequestedAt: T0 + 60_000 } });
  });

  it('enabled true → false → a late "true" answer never lets the window publish again', () => {
    let state = owner();
    state = publisherApplyPolicy(state, { requestSeq: 3, requestedAt: T0 + 10_000, policy: policy(11, false) }).state;
    expect(publisherCanPublish(state, on, T0 + 10_001)).toBe(false);
    state = publisherApplyPolicy(state, { requestSeq: 2, requestedAt: T0 + 5_000, policy: policy(10, true) }).state;
    expect(publisherCanPublish(state, on, T0 + 10_002)).toBe(false);
  });

  it('validity counts from the start of the applied request; when it passes the window stops publishing', () => {
    const state = owner();
    expect(publisherCanPublish(state, on, T0 + POLICY_VALID_MS - 1)).toBe(true);
    expect(publisherCanPublish(state, on, T0 + POLICY_VALID_MS)).toBe(false);
  });

  it('numbers snapshots, ties ui to the last snapshot and builds messages every receiver accepts', () => {
    let state = owner();
    expect(publisherUi(state, ui)).toBeNull();
    const first = publisherState(state, snapshot);
    state = first.state;
    expect(first.message).toMatchObject({ seq: 1, epoch: 77, gen: 2, policyVersion: 10, validUntil: T0 + POLICY_VALID_MS, mode: 'order' });
    const second = publisherState(state, null);
    expect(second.message).toMatchObject({ seq: 2, mode: 'blank', snapshot: null });
    const uiMessage = publisherUi(second.state, ui);
    expect(uiMessage).toMatchObject({ stateSeq: 2 });
    const confirm = publisherConfirm(second.state);
    expect(confirm).toMatchObject({ policyVersion: 10, validUntil: T0 + POLICY_VALID_MS });
    for (const message of [first.message, second.message, uiMessage, confirm]) expect(parseClientScreenMessage(structuredClone(message))).toEqual(message);
    expect(publisherConfirm(createPublisherState(A))).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  decideApply, diffEpisodes, initialApplyState, resolveMessageRoles, roleOpensPacketSignal, signalFreshness, signalOrigin,
  type ApplyDecisionInput,
} from './cnc-chat-signals.domain';

const at = (iso: string) => new Date(iso);

describe('resolveMessageRoles (F17)', () => {
  it('takes roles from the worker audit when every message is audited', () => {
    const roles = resolveMessageRoles({ sentMessageIds: ['10', '11', '12'], fileCount: 3,
      auditRoles: new Map([['10', 'file'], ['11', 'file'], ['12', 'comment']]) });
    expect([...roles.values()].map((role) => role.role)).toEqual(['file', 'file', 'comment']);
    expect(roles.get('12')!.source).toBe('worker_audit');
  });

  it('treats the last of files + 1 ids as the mandatory «Задание №…» comment even without user text', () => {
    const roles = resolveMessageRoles({ sentMessageIds: ['1', '2', '3', '4'], fileCount: 3, auditRoles: new Map() });
    expect(roles.get('4')).toEqual({ role: 'comment', source: 'send_order' });
    expect(roles.get('1')).toEqual({ role: 'file', source: 'send_order' });
  });

  it('marks every id as a file when ids equal files, and ambiguous counts as unknown', () => {
    expect(resolveMessageRoles({ sentMessageIds: ['1', '2'], fileCount: 2, auditRoles: new Map() }).get('2')!.role).toBe('file');
    const ambiguous = resolveMessageRoles({ sentMessageIds: ['1', '2', '3', '4', '5'], fileCount: 2, auditRoles: new Map() });
    expect([...ambiguous.values()].every((role) => role.role === 'unknown')).toBe(true);
  });

  it('opens a packet signal only from a file message (empty text + no audit + 👍 on the job number → journal only)', () => {
    const roles = resolveMessageRoles({ sentMessageIds: ['1', '2'], fileCount: 1, auditRoles: new Map() });
    expect(roleOpensPacketSignal(roles.get('2')!.role)).toBe(false);
    expect(roleOpensPacketSignal('unknown')).toBe(false);
    expect(roleOpensPacketSignal('file')).toBe(true);
  });
});

describe('diffEpisodes (F6, F14)', () => {
  const ivan = { peerType: 'user' as const, peerId: '1', displayName: 'Иван', username: null, reactedAt: null };
  const petr = { peerType: 'user' as const, peerId: '2', displayName: 'Пётр', username: null, reactedAt: null };

  it('closes every open episode when 👍 is gone', () => {
    expect(diffEpisodes({ thumbsCount: 0, authors: null, open: [{ signalId: 5, peerType: 'user', peerId: '1' }] }))
      .toEqual({ open: [], close: [5] });
  });

  it('A removed, B added with an unchanged count: a complete list closes A and opens B', () => {
    const diff = diffEpisodes({ thumbsCount: 1, authors: { state: 'complete', reactors: [petr] },
      open: [{ signalId: 5, peerType: 'user', peerId: '1' }] });
    expect(diff.close).toEqual([5]);
    expect(diff.open).toEqual([petr]);
  });

  it('a partial list never closes named authors', () => {
    const diff = diffEpisodes({ thumbsCount: 2, authors: { state: 'partial', reactors: [petr] },
      open: [{ signalId: 5, peerType: 'user', peerId: '1' }] });
    expect(diff.close).toEqual([]);
    expect(diff.open).toEqual([petr]);
  });

  it('opens one anonymous episode when authors are unavailable, and supersedes it once a name is known', () => {
    const anonymous = diffEpisodes({ thumbsCount: 1, authors: { state: 'unavailable', reactors: [] }, open: [] });
    expect(anonymous.open).toEqual([{ peerType: 'anonymous', peerId: '0', displayName: null, username: null, reactedAt: null }]);
    const named = diffEpisodes({ thumbsCount: 1, authors: { state: 'partial', reactors: [ivan] },
      open: [{ signalId: 9, peerType: 'anonymous', peerId: '0' }] });
    expect(named.close).toEqual([9]);
    expect(named.open).toEqual([ivan]);
  });

  it('types a channel reactor separately from a user with the same id', () => {
    const channel = { ...ivan, peerType: 'channel' as const };
    const diff = diffEpisodes({ thumbsCount: 2, authors: { state: 'complete', reactors: [ivan, channel] },
      open: [{ signalId: 1, peerType: 'user', peerId: '1' }] });
    expect(diff.close).toEqual([]);
    expect(diff.open).toEqual([channel]);
  });
});

describe('origin, freshness and the initial state (F7, F12)', () => {
  const activatedAt = at('2026-11-05T10:00:00Z');
  it('a 👍 already present at the first poll of an old send is baseline and held', () => {
    const origin = signalOrigin({ sendFinishedAt: at('2026-11-01T10:00:00Z'), activatedAt, firstPoll: true });
    expect(origin).toBe('baseline');
    expect(initialApplyState({ origin, applyToPacket: true })).toBe('held_baseline');
  });

  it('a live signal is pending only with the switch on', () => {
    expect(initialApplyState({ origin: 'live', applyToPacket: true })).toBe('pending');
    expect(initialApplyState({ origin: 'live', applyToPacket: false })).toBe('held_disabled');
  });

  it('is fresh with a recent previous zero poll or a recent reaction time; late after downtime', () => {
    const base = { observedAt: at('2026-11-05T12:00:00Z'), sendFinishedAt: at('2026-11-05T11:00:00Z'), activatedAt,
      reactedAt: null, previousSuccessfulPollAt: at('2026-11-05T11:58:00Z'), previousThumbsCount: 0 };
    expect(signalFreshness(base)).toBe('fresh');
    expect(signalFreshness({ ...base, previousSuccessfulPollAt: at('2026-11-05T11:00:00Z') })).toBe('late');
    expect(signalFreshness({ ...base, previousSuccessfulPollAt: null, reactedAt: at('2026-11-05T09:00:00Z') })).toBe('fresh');
    expect(signalFreshness({ ...base, sendFinishedAt: at('2026-11-04T11:00:00Z') })).toBe('late');
  });
});

describe('decideApply (F11, F12)', () => {
  const now = at('2026-11-05T12:00:00Z');
  const base: ApplyDecisionInput = {
    mode: 'auto', applyState: 'pending', origin: 'live', engineQueued: false, signalOpen: true, anyFileMessageMissing: false,
    lastPositiveObservedAt: at('2026-11-05T11:55:00Z'), now, packetCompleted: false, returnBarrier: false,
    returnHistory: false, applyToPacket: true,
  };

  it('applies a fresh pending live signal', () => {
    expect(decideApply(base)).toEqual({ kind: 'apply' });
  });

  it('a stale observation is answered, not persisted, and recovers after a fresh poll', () => {
    expect(decideApply({ ...base, lastPositiveObservedAt: at('2026-11-05T11:40:00Z') }))
      .toEqual({ kind: 'blocked', reason: 'stale_observation' });
    expect(decideApply({ ...base, lastPositiveObservedAt: at('2026-11-05T11:59:00Z') })).toEqual({ kind: 'apply' });
  });

  it('active MDF engine holds the signal (the engine completes packets), shadow/legacy apply', () => {
    expect(decideApply({ ...base, engineQueued: true })).toEqual({ kind: 'hold', state: 'held_engine', reason: 'engine_mode' });
  });

  it('auto never applies baseline/disabled/history; manual does, but never through an active return barrier', () => {
    expect(decideApply({ ...base, applyState: 'held_baseline' }).kind).toBe('blocked');
    expect(decideApply({ ...base, mode: 'manual', applyState: 'held_baseline' })).toEqual({ kind: 'apply' });
    expect(decideApply({ ...base, mode: 'manual', applyState: 'held_disabled', applyToPacket: false })).toEqual({ kind: 'apply' });
    expect(decideApply({ ...base, returnHistory: true })).toEqual({ kind: 'hold', state: 'held_history', reason: 'not_eligible' });
    expect(decideApply({ ...base, mode: 'manual', applyState: 'held_history', returnHistory: true })).toEqual({ kind: 'apply' });
    expect(decideApply({ ...base, mode: 'manual', returnBarrier: true }))
      .toEqual({ kind: 'hold', state: 'held_return_barrier', reason: 'return_barrier' });
    expect(decideApply({ ...base, mode: 'manual', applyState: 'held_return_barrier' }))
      .toEqual({ kind: 'blocked', reason: 'return_barrier' });
  });

  it('the switch turned off after opening holds an automatic apply', () => {
    expect(decideApply({ ...base, applyToPacket: false })).toEqual({ kind: 'hold', state: 'held_disabled', reason: 'not_eligible' });
  });

  it('closed or deleted signals are never applied; completed packets are held as already completed', () => {
    expect(decideApply({ ...base, signalOpen: false })).toEqual({ kind: 'blocked', reason: 'closed' });
    expect(decideApply({ ...base, anyFileMessageMissing: true })).toEqual({ kind: 'blocked', reason: 'closed' });
    expect(decideApply({ ...base, packetCompleted: true }))
      .toEqual({ kind: 'hold', state: 'already_completed', reason: 'already_completed' });
    expect(decideApply({ ...base, applyState: 'applied' })).toEqual({ kind: 'blocked', reason: 'already_applied' });
  });

  it('auto never applies a baseline signal even after a retry state', () => {
    expect(decideApply({ ...base, origin: 'baseline', applyState: 'retry_wait' })).toEqual({ kind: 'blocked', reason: 'not_eligible' });
    expect(decideApply({ ...base, mode: 'manual', origin: 'baseline', applyState: 'held_baseline' })).toEqual({ kind: 'apply' });
  });

  it('manual may retry failed_final; auto picks only pending/retry_wait', () => {
    expect(decideApply({ ...base, mode: 'manual', applyState: 'failed_final' })).toEqual({ kind: 'apply' });
    expect(decideApply({ ...base, applyState: 'failed_final' }).kind).toBe('blocked');
    expect(decideApply({ ...base, applyState: 'retry_wait' })).toEqual({ kind: 'apply' });
  });
});

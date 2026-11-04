/**
 * «Распилено» from the CNC chat — pure rules (plan spec_erp/plans/cnc-chat-sawn-signals, §11–§14).
 * A 👍 under a file the bot sent is an incoming signal; the journal records it whatever the MDF board does.
 */

export type MessageRole = 'file' | 'comment' | 'unknown';
export type RoleSource = 'worker_audit' | 'send_order' | 'ambiguous';
export type PeerType = 'user' | 'channel' | 'chat';
export type AuthorsState = 'complete' | 'partial' | 'unavailable';
export type ApplyState =
  | 'pending' | 'held_disabled' | 'held_baseline' | 'held_history' | 'held_return_barrier' | 'held_engine'
  | 'retry_wait' | 'failed_final' | 'applied' | 'already_completed' | 'closed';
export type BlockedReason =
  | 'stale_observation' | 'closed' | 'return_barrier' | 'engine_mode' | 'already_completed' | 'already_applied'
  | 'read_only' | 'not_eligible';

export const POSITIVE_OBSERVATION_MAX_AGE_MS = 15 * 60_000;
export const FRESH_REACTION_MAX_AGE_MS = 6 * 60 * 60_000;
export const FRESH_PREVIOUS_POLL_MAX_AGE_MS = 30 * 60_000;
export const AUTHORS_RECHECK_MS = 30 * 60_000;
export const OBSERVATION_WINDOW_DAYS = 30;
export const RECENT_SEND_MS = 7 * 24 * 60 * 60_000;
export const RECENT_POLL_INTERVAL_MS = 2 * 60_000;
export const OLD_POLL_INTERVAL_MS = 30 * 60_000;
export const MAX_APPLY_ATTEMPTS = 10;

/** States the automatic path (after a report, retries) may pick up. */
export const AUTO_APPLY_STATES: readonly ApplyState[] = ['pending', 'retry_wait'];
/** States a user may apply with «Применить накопленные» (an explicit confirmation bypasses the switch). */
export const MANUAL_APPLY_STATES: readonly ApplyState[] = [
  'pending', 'held_disabled', 'held_baseline', 'held_history', 'retry_wait', 'failed_final',
];
export const TERMINAL_APPLY_STATES: readonly ApplyState[] = ['applied', 'already_completed', 'closed'];

/**
 * Role of every message id of one manual send (F17). The worker always sends the files one message each and then
 * a separate «Задание №…» message last, even without the user's text.
 * 1) the worker audit says which message carried the reply text; 2) otherwise ids = files + 1 → the last is the
 * comment, ids = files → all are files; 3) anything else is ambiguous → `unknown` (journal only).
 */
export function resolveMessageRoles(input: {
  sentMessageIds: readonly string[];
  fileCount: number;
  auditRoles: ReadonlyMap<string, 'file' | 'comment'>;
}): Map<string, { role: MessageRole; source: RoleSource }> {
  const roles = new Map<string, { role: MessageRole; source: RoleSource }>();
  const ids = input.sentMessageIds;
  const allAudited = ids.length > 0 && ids.every((id) => input.auditRoles.has(id));
  if (allAudited) {
    for (const id of ids) roles.set(id, { role: input.auditRoles.get(id)!, source: 'worker_audit' });
    return roles;
  }
  if (input.fileCount > 0 && ids.length === input.fileCount + 1) {
    ids.forEach((id, index) => roles.set(id, {
      role: index === ids.length - 1 ? 'comment' : 'file',
      source: 'send_order',
    }));
    return roles;
  }
  if (input.fileCount > 0 && ids.length === input.fileCount) {
    for (const id of ids) roles.set(id, { role: 'file', source: 'send_order' });
    return roles;
  }
  for (const id of ids) {
    const audited = input.auditRoles.get(id);
    roles.set(id, audited ? { role: audited, source: 'worker_audit' } : { role: 'unknown', source: 'ambiguous' });
  }
  return roles;
}

/** Only a file message can open or keep a packet signal (parity with the old import and #207). */
export function roleOpensPacketSignal(role: MessageRole): boolean {
  return role === 'file';
}

export interface ReportedReactor {
  peerType: PeerType;
  peerId: string;
  displayName: string | null;
  username: string | null;
  reactedAt: string | null;
}

export interface OpenEpisode {
  signalId: number;
  peerType: PeerType | 'anonymous';
  peerId: string;
}

export interface EpisodeDiff {
  open: Array<ReportedReactor | { peerType: 'anonymous'; peerId: '0'; displayName: null; username: null; reactedAt: null }>;
  close: number[];
}

const ANONYMOUS = { peerType: 'anonymous', peerId: '0', displayName: null, username: null, reactedAt: null } as const;

/**
 * Reactor episodes of one present message (F6, F14). Named episodes are closed only by a complete list; with a
 * partial/unavailable/absent list a 👍 without any open episode opens one anonymous episode, and only 0 👍 closes.
 */
export function diffEpisodes(input: {
  thumbsCount: number;
  authors: { state: AuthorsState; reactors: ReportedReactor[] } | null;
  open: readonly OpenEpisode[];
}): EpisodeDiff {
  if (input.thumbsCount <= 0) return { open: [], close: input.open.map((episode) => episode.signalId) };
  const key = (peerType: string, peerId: string) => `${peerType}:${peerId}`;
  const openKeys = new Map(input.open.map((episode) => [key(episode.peerType, episode.peerId), episode.signalId]));
  const reactors = input.authors?.state === 'unavailable' ? [] : uniqueReactors(input.authors?.reactors ?? []);
  const toOpen: EpisodeDiff['open'] = reactors.filter((reactor) => !openKeys.has(key(reactor.peerType, reactor.peerId)));
  const close: number[] = [];
  if (input.authors?.state === 'complete' && reactors.length > 0) {
    const present = new Set(reactors.map((reactor) => key(reactor.peerType, reactor.peerId)));
    for (const episode of input.open) if (!present.has(key(episode.peerType, episode.peerId))) close.push(episode.signalId);
  } else if (reactors.length > 0) {
    // A named author is now known: the anonymous placeholder is superseded.
    for (const episode of input.open) if (episode.peerType === 'anonymous') close.push(episode.signalId);
  }
  const remainingOpen = input.open.length - close.length + toOpen.length;
  if (remainingOpen === 0) toOpen.push(ANONYMOUS);
  return { open: toOpen, close };
}

function uniqueReactors(reactors: readonly ReportedReactor[]): ReportedReactor[] {
  const seen = new Set<string>();
  return reactors.filter((reactor) => {
    const key = `${reactor.peerType}:${reactor.peerId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Notification freshness (F7): fresh only for a message sent after activation and either a known reaction time
 * within 6 h, or a previous successful poll ≤30 min earlier that saw 0 👍. Everything else is «late»: journal,
 * audit and the packet event, but no per-order notification fan-out.
 */
export function signalFreshness(input: {
  observedAt: Date;
  sendFinishedAt: Date;
  activatedAt: Date;
  reactedAt: Date | null;
  previousSuccessfulPollAt: Date | null;
  previousThumbsCount: number;
}): 'fresh' | 'late' {
  if (input.sendFinishedAt.getTime() < input.activatedAt.getTime()) return 'late';
  if (input.reactedAt && input.observedAt.getTime() - input.reactedAt.getTime() <= FRESH_REACTION_MAX_AGE_MS) return 'fresh';
  if (
    input.previousSuccessfulPollAt
    && input.previousThumbsCount === 0
    && input.observedAt.getTime() - input.previousSuccessfulPollAt.getTime() <= FRESH_PREVIOUS_POLL_MAX_AGE_MS
  ) return 'fresh';
  return 'late';
}

/** Baseline: the 👍 was already there at the first poll of a message sent before activation (never auto-applied). */
export function signalOrigin(input: { sendFinishedAt: Date; activatedAt: Date; firstPoll: boolean }): 'live' | 'baseline' {
  return input.firstPoll && input.sendFinishedAt.getTime() < input.activatedAt.getTime() ? 'baseline' : 'live';
}

export function initialApplyState(input: { origin: 'live' | 'baseline'; applyToPacket: boolean }): ApplyState {
  if (input.origin === 'baseline') return 'held_baseline';
  return input.applyToPacket ? 'pending' : 'held_disabled';
}

export function nextPollDelayMs(sendFinishedAt: Date, now: Date): number {
  return now.getTime() - sendFinishedAt.getTime() <= RECENT_SEND_MS ? RECENT_POLL_INTERVAL_MS : OLD_POLL_INTERVAL_MS;
}

export function retryDelayMs(attempts: number): number {
  return Math.min(300_000, 2_000 * 2 ** Math.max(0, attempts - 1));
}

export interface ApplyDecisionInput {
  mode: 'auto' | 'manual' | 'preview';
  applyState: ApplyState;
  origin: 'live' | 'baseline';
  engineQueued: boolean;
  signalOpen: boolean;
  anyFileMessageMissing: boolean;
  lastPositiveObservedAt: Date;
  now: Date;
  packetCompleted: boolean;
  returnBarrier: boolean;
  returnHistory: boolean;
  applyToPacket: boolean;
}

export type ApplyDecision =
  | { kind: 'apply' }
  | { kind: 'hold'; state: ApplyState; reason: BlockedReason }
  | { kind: 'blocked'; reason: BlockedReason };

/**
 * One decision table (F12), evaluated under the packet and signal locks after the MDF boundary.
 * `hold` persists a state; `blocked` answers without changing the signal (F11: a stale observation recovers by
 * itself at the next positive poll).
 */
export function decideApply(input: ApplyDecisionInput): ApplyDecision {
  if (input.applyState === 'applied') return { kind: 'blocked', reason: 'already_applied' };
  if (input.applyState === 'already_completed') return { kind: 'blocked', reason: 'already_completed' };
  if (input.applyState === 'closed' || !input.signalOpen) return { kind: 'blocked', reason: 'closed' };
  // A baseline 👍 is applied only by an explicit user confirmation, never by the automatic path (R2 #1).
  if (input.mode === 'auto' && input.origin === 'baseline') return { kind: 'blocked', reason: 'not_eligible' };
  const allowed = input.mode === 'auto' ? AUTO_APPLY_STATES : MANUAL_APPLY_STATES;
  if (!allowed.includes(input.applyState) && !(input.mode !== 'auto' && input.applyState === 'held_engine')) {
    return { kind: 'blocked', reason: input.applyState === 'held_return_barrier' ? 'return_barrier' : 'not_eligible' };
  }
  if (input.engineQueued) return { kind: 'hold', state: 'held_engine', reason: 'engine_mode' };
  if (input.anyFileMessageMissing) return { kind: 'blocked', reason: 'closed' };
  if (input.now.getTime() - input.lastPositiveObservedAt.getTime() > POSITIVE_OBSERVATION_MAX_AGE_MS) {
    return { kind: 'blocked', reason: 'stale_observation' };
  }
  if (input.packetCompleted) return { kind: 'hold', state: 'already_completed', reason: 'already_completed' };
  if (input.returnBarrier) return { kind: 'hold', state: 'held_return_barrier', reason: 'return_barrier' };
  if (input.mode === 'auto') {
    if (input.returnHistory) return { kind: 'hold', state: 'held_history', reason: 'not_eligible' };
    if (!input.applyToPacket) return { kind: 'hold', state: 'held_disabled', reason: 'not_eligible' };
  }
  return { kind: 'apply' };
}

/** Errors of the MDF boundary that mean «try again later» (read-only mode, cutover freeze from #207). */
export const MDF_RETRY_LATER_CODES: readonly string[] = ['MDF_ENGINE_READ_ONLY', 'MDF_CUTOVER_IN_PROGRESS'];

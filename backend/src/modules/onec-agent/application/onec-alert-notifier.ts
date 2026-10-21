import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { DatabaseClient } from '../../../database/database.types';
import { PgNotificationWriteAdapter } from '../../notifications-engine/adapters/pg-notification-write';
import { ONEC_ALERT_NOTIFICATION_SOURCE } from '../../notifications-engine/domain/notification-event-registry';
import { WhatsAppNotificationPort } from '../../whatsapp/notifications/whatsapp-notification.port';
import type { WhatsAppNotificationRecipient } from '../../whatsapp/notifications/whatsapp-notification.types';
import {
  PgOnecAlertNotificationsRepository,
  type AlarmDelivery,
  type EpisodeCandidate,
  type ExternalRecipientRow,
  type LockedDispatch,
  type OnecAlertExternalState,
  type OnecAlertPolicy,
  type RecipientCandidate,
  type RecipientRowInput,
} from '../adapters/pg-onec-alert-notifications-repository';
import { PgOnecRepository } from '../adapters/pg-onec-repository';
import {
  NO_RECIPIENTS_ALERT_KIND,
  buildOnecAlertText,
  effectiveImportance,
  importanceRank,
  levelForImportance,
  maxImportance,
  onecAlertGroup,
  onecAlertGroupOf,
  quietHoursEnd,
  type OnecAlertGroupCode,
  type OnecAlertImportance,
  type OnecAlertStage,
} from '../domain/onec-alert-groups';
import { OnecRuntimeConfigService } from '../onec-runtime-config.service';
import { OnecAuditWriter } from './onec-audit';

/** Entity of the bell row: the FE opens «Интеграция 1С» for it (BalloonCenter entityPath). */
export const ONEC_ALERT_DISPATCH_ENTITY = 'onec_alert_dispatch';
export const ONEC_ALERT_NOTIFIER_ACTOR = 'onec-alert-notifier';
const NO_RECIPIENTS_DEDUPE_KEY = NO_RECIPIENTS_ALERT_KIND;

/**
 * Plan §2.5: at most 200 episodes per dispatch, 5 sent dispatches per tick, 12 reminders per episode. Attempts are
 * bounded separately (R1-3): a dispatch with nobody to deliver to does not use the budget of the sent ones. Plans
 * that never failed go first; failed or undeliverable ones follow, the longest ago tried first (R2-2) — a fair queue
 * across ticks, so any number of failing plans cannot keep a deliverable one from its turn.
 */
export const ONEC_ALERT_DISPATCH_LIMITS = { membersPerDispatch: 200, dispatchesPerTick: 5, attemptsPerTick: 20, maxReminders: 12 } as const;
/** A dispatcher silent this long while active is treated as switched off: the next tick cuts off again (R1-4). */
export const ONEC_ALERT_DISPATCHER_GAP_MINUTES = 30;

/**
 * External part of dispatches (plan §2.5, §5). Per tick: delayed dispatches released, closed alarm dispatches
 * cancelled, watched channel rows polled. A delivery the channel cancelled for `delivery_gap` (backend restarted)
 * or `expired` gets a new attempt of the same recipient row, at most 3 attempts; only while the dispatch is still
 * relevant (an alarm stage — some member open; `resolved` — within its 6 h lifetime).
 */
export const ONEC_ALERT_EXTERNAL_LIMITS = {
  releasesPerTick: 20,
  cancelsPerTick: 20,
  watchedPerTick: 200,
  maxAttempts: 3,
  alarmLifetimeMs: 2 * 60 * 60_000,
  resolvedLifetimeMs: 6 * 60 * 60_000,
} as const;
const REDELIVER_REASONS = new Set(['delivery_gap', 'expired']);
const FINAL_CHANNEL_STATES = new Set(['sent', 'failed', 'unknown', 'cancelled', 'skipped']);
/** Every recipient of a 1C alert must still have it when the channel sends (it is re-checked there). */
const WHATSAPP_REQUIRED_PERMISSION = 'onec.view' as const;

export type OnecAlertWhatsAppTarget = { userId: number } | { chatId: string };

/** WhatsApp targets of a policy: each recipient personally (`whatsapp`) and/or the policy's chat (`whatsapp_chat`). */
export function whatsappTargets(policy: Pick<OnecAlertPolicy, 'externalChannels' | 'whatsappChatId'>, userIds: readonly number[]): OnecAlertWhatsAppTarget[] {
  const targets: OnecAlertWhatsAppTarget[] = [];
  if (policy.externalChannels.includes('whatsapp')) for (const userId of userIds) targets.push({ userId });
  if (policy.externalChannels.includes('whatsapp_chat') && policy.whatsappChatId) targets.push({ chatId: policy.whatsappChatId });
  return targets;
}

/** Idempotency key of one WhatsApp delivery (plan §5): `onec-alert:{dispatch}:whatsapp:{user:<id>|chat:<id>}:attempt{n}`. */
export function whatsappKey(dispatchId: number, target: OnecAlertWhatsAppTarget, attempt: number): string {
  const who = 'userId' in target ? `user:${target.userId}` : `chat:${target.chatId}`;
  return `onec-alert:${dispatchId}:whatsapp:${who}:attempt${attempt}`;
}

/**
 * Send window of an external delivery (plan §2.9, §5): not before the end of the quiet hours (critical alerts ignore
 * them when the policy says so; recovery notices never do), lifetime 2 h (6 h for `resolved`) from the later of now
 * and that start — so it always ends after the start.
 */
export function externalWindow(
  input: { stage: OnecAlertStage; importance: OnecAlertImportance; policy: Pick<OnecAlertPolicy, 'quietHours' | 'criticalIgnoresQuietHours'> },
  now: Date,
): { notBefore: Date | null; expiresAt: Date } {
  const bypass = input.stage !== 'resolved' && input.importance === 'critical' && input.policy.criticalIgnoresQuietHours;
  const notBefore = bypass ? null : quietHoursEnd(input.policy.quietHours, now);
  const start = Math.max(now.getTime(), notBefore?.getTime() ?? 0);
  const lifetime = input.stage === 'resolved' ? ONEC_ALERT_EXTERNAL_LIMITS.resolvedLifetimeMs : ONEC_ALERT_EXTERNAL_LIMITS.alarmLifetimeMs;
  return { notBefore, expiresAt: new Date(start + lifetime) };
}

/**
 * Whether a dispatch still deserves its external delivery (redeliver, delay release). An alarm — while some member is
 * open. A recovery notice — until the lifetime its first attempt got (`expiresAt`, which already counts the quiet
 * hours, R1-2); without it, 6 h from the dispatch.
 */
export function externalStillRelevant(
  dispatch: Pick<LockedDispatch, 'stage' | 'createdAt'>,
  members: readonly Pick<EpisodeCandidate, 'resolvedAt'>[],
  now: Date,
  firstExpiresAt: Date | null = null,
): boolean {
  if (dispatch.stage === 'resolved') {
    const until = firstExpiresAt?.getTime() ?? dispatch.createdAt.getTime() + ONEC_ALERT_EXTERNAL_LIMITS.resolvedLifetimeMs;
    return now.getTime() < until;
  }
  return members.some((member) => member.resolvedAt === null);
}

/** A recovery notice waits this long between checks of its alarm still in flight. */
export const ONEC_ALERT_RECOVERY_RECHECK_SECONDS = 60;
/**
 * Upper bound of that wait, from the recovery dispatch: an alarm delivery ends by its own lifetime (quiet hours ≤ 24 h
 * + 2 h) and a delayed alarm by its delay (≤ 2 h), so this only guards against a stuck row.
 */
export const ONEC_ALERT_RECOVERY_WAIT_MS = 26 * 60 * 60_000;
/** The channel states in which the alarm may have reached the phone: the recovery notice follows it there. */
const ALARM_REACHED_STATES = new Set(['sent', 'unknown']);

export interface RecoveryPlan {
  /** An episode's alarm to some target, not reached yet, is still in flight or delayed: decide later. */
  pending: boolean;
  /** Targets grouped by the episodes whose alarm reached them; each group gets a text of those episodes only. */
  sends: { targets: OnecAlertWhatsAppTarget[]; episodeIds: number[] }[];
  /** Targets no alarm of these episodes reached. */
  skip: OnecAlertWhatsAppTarget[];
}

/**
 * WhatsApp of a recovery notice, per episode and target (R5): a target gets «Восстановлено» about exactly the episodes
 * whose alarm reached it (any alarm stage, `sent` or `unknown` — maybe sent), so nobody hears of the recovery of an
 * alarm they never saw (spared by the delay or a blink, failed, cancelled, sent to someone else). An episode not yet
 * reached whose alarm to that target is still in flight, or sits in a delayed alarm dispatch, makes the plan
 * `pending` — unless `final` (the wait is over): then it counts as not reached.
 */
export function recoveryPlan(
  targets: readonly OnecAlertWhatsAppTarget[],
  episodeIds: readonly number[],
  alarm: AlarmDelivery,
  final: boolean,
): RecoveryPlan {
  const delayed = new Set(alarm.delayedEpisodeIds);
  const sends = new Map<string, { targets: OnecAlertWhatsAppTarget[]; episodeIds: number[] }>();
  const skip: OnecAlertWhatsAppTarget[] = [];
  let pending = false;
  for (const target of targets) {
    const rows = alarm.rows.filter((row) => ('userId' in target ? row.userId === target.userId : row.chatId === target.chatId));
    const reached = episodeIds.filter((id) =>
      rows.some((row) => row.episodeId === id && row.channelState !== null && ALARM_REACHED_STATES.has(row.channelState)),
    );
    const waiting = episodeIds.some(
      (id) => !reached.includes(id) && (delayed.has(id) || rows.some((row) => row.episodeId === id && row.channelState === null)),
    );
    if (waiting && !final) pending = true;
    if (reached.length === 0) {
      skip.push(target);
      continue;
    }
    const key = reached.join(',');
    const group = sends.get(key) ?? { targets: [], episodeIds: reached };
    group.targets.push(target);
    sends.set(key, group);
  }
  return { pending, sends: [...sends.values()], skip };
}

export const planKey = (plan: Pick<PlannedDispatch, 'stage' | 'group' | 'sourceId'>) => `${plan.stage}|${plan.group}|${plan.sourceId ?? ''}`;

const STAGE_ORDER: Record<OnecAlertStage, number> = { digest: 0, opened: 1, escalated: 2, resolved: 3, reminder: 4 };

export interface PlannedDispatch {
  group: OnecAlertGroupCode;
  sourceId: number | null;
  stage: OnecAlertStage;
  episodeIds: number[];
}

/**
 * The next stage of one episode under its group's policy, or null (plan §2.5). The aggregation window of the opening
 * is not checked here — it applies to the whole group of pending episodes (planOnecAlertDispatches).
 */
export function nextStageOf(episode: EpisodeCandidate, policy: OnecAlertPolicy): OnecAlertStage | null {
  if (episode.status === 'pending') return 'opened';
  if (episode.status === 'closed_unnotified') return episode.resolvedAt === null ? 'digest' : null;
  if (episode.status !== 'notified' || episode.firstImportance === null) return null;
  if (episode.resolvedAt !== null) return !episode.hasResolved && policy.notifyResolved ? 'resolved' : null;
  const importance = effectiveImportance(policy.importance, episode.severityMax);
  if (!episode.hasEscalated && importanceRank(importance) > importanceRank(episode.firstImportance)) return 'escalated';
  // Only critical alerts are repeated, until someone presses «Принять» on the «1С» screen.
  if (
    importance === 'critical' &&
    policy.repeatMinutes !== null &&
    episode.acknowledgedAt === null &&
    episode.reminders < ONEC_ALERT_DISPATCH_LIMITS.maxReminders &&
    (episode.sinceLastStageSeconds ?? 0) >= policy.repeatMinutes * 60
  ) {
    return 'reminder';
  }
  return null;
}

/**
 * Groups episodes by (stage, alert group, 1C source) into dispatches. An opening waits for companions until the
 * oldest pending episode of its group is older than the group's window (0 — at once). Every dispatch holds at most
 * 200 episodes; the order is digest, opened, escalated, resolved, reminder, then by importance.
 */
export function planOnecAlertDispatches(candidates: readonly EpisodeCandidate[], policies: ReadonlyMap<OnecAlertGroupCode, OnecAlertPolicy>): PlannedDispatch[] {
  const buckets = new Map<string, { plan: PlannedDispatch; oldest: number; importance: OnecAlertImportance }>();
  for (const episode of candidates) {
    const group = onecAlertGroupOf(episode.kind);
    const policy = policies.get(group);
    if (!policy) continue;
    const stage = nextStageOf(episode, policy);
    if (!stage) continue;
    const key = `${stage}|${group}|${episode.sourceId ?? ''}`;
    const importance = effectiveImportance(policy.importance, episode.severityMax);
    const bucket = buckets.get(key) ?? { plan: { group, sourceId: episode.sourceId, stage, episodeIds: [] }, oldest: 0, importance: 'info' as OnecAlertImportance };
    bucket.plan.episodeIds.push(episode.episodeId);
    bucket.oldest = Math.max(bucket.oldest, episode.ageSeconds);
    bucket.importance = maxImportance([bucket.importance, importance]);
    buckets.set(key, bucket);
  }
  const ready = [...buckets.values()].filter(({ plan, oldest }) => plan.stage !== 'opened' || oldest >= onecAlertGroup(plan.group).windowSeconds);
  ready.sort((a, b) => STAGE_ORDER[a.plan.stage] - STAGE_ORDER[b.plan.stage] || importanceRank(b.importance) - importanceRank(a.importance));
  const plans: PlannedDispatch[] = [];
  for (const { plan } of ready) {
    for (let i = 0; i < plan.episodeIds.length; i += ONEC_ALERT_DISPATCH_LIMITS.membersPerDispatch) {
      plans.push({ ...plan, episodeIds: plan.episodeIds.slice(i, i + ONEC_ALERT_DISPATCH_LIMITS.membersPerDispatch) });
    }
  }
  return plans;
}

/**
 * Fair order across ticks (R2-2): plans that have not failed keep the planned order and go first; failed ones follow
 * by the tick of their last attempt, oldest first (stable within a tick).
 */
export function orderFairly(planned: readonly PlannedDispatch[], failedAt: ReadonlyMap<string, number>): PlannedDispatch[] {
  const fresh = planned.filter((plan) => !failedAt.has(planKey(plan)));
  const failed = planned
    .map((plan, index) => ({ plan, index, at: failedAt.get(planKey(plan)) }))
    .filter((entry): entry is { plan: PlannedDispatch; index: number; at: number } => entry.at !== undefined)
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((entry) => entry.plan);
  return [...fresh, ...failed];
}

/**
 * Recipients with the fallback chain (plan §2.4): configured ∩ (active ∧ literal onec.view) → onec.manage+onec.view →
 * superadmins with onec.view → nobody. Candidates already satisfy «active ∧ literal onec.view».
 */
export function chooseRecipients(candidates: readonly RecipientCandidate[]): { level: 1 | 2 | 3; users: RecipientCandidate[] } | null {
  const configured = candidates.filter((user) => user.configured);
  if (configured.length > 0) return { level: 1, users: configured };
  const managers = candidates.filter((user) => user.manage);
  if (managers.length > 0) return { level: 2, users: managers };
  const superadmins = candidates.filter((user) => user.superadmin);
  if (superadmins.length > 0) return { level: 3, users: superadmins };
  return null;
}

export type DispatchOutcome =
  | { kind: 'sent'; dispatchId: number; recipients: number; fallbackLevel: number }
  | { kind: 'nothing' }
  | { kind: 'no_recipients'; group: OnecAlertGroupCode };

export interface NotifierTickResult {
  active: boolean;
  switchedOn: boolean;
  dispatches: DispatchOutcome[];
}

/**
 * Delivery of 1C alerts (plan 2026-10-19 §2.1): runs inside the 1C monitor tick, under its advisory lock (one
 * executor per cluster), independent of the notification rules engine. Every dispatch is ONE transaction: the
 * dispatch, all its members, the bell rows with the mandatory balloon, the recipient journal, the episode status and
 * the audit event commit or roll back together; a failed dispatch is retried whole on the next tick. Bell row key
 * `onec_alert:{dispatch_id}:{user_id}` — the dispatch id exists only after commit, so a retry never duplicates.
 * WhatsApp (plan §5) goes through the channel's port in the same transaction, each call behind a SAVEPOINT: a failing
 * channel never takes the mandatory minimum with it. Telegram comes later.
 */
@Injectable()
export class OnecAlertNotifier {
  private readonly logger = new Logger(OnecAlertNotifier.name);
  private readonly write = new PgNotificationWriteAdapter();
  /** Plans that failed or had nobody to deliver to → the tick number of their last attempt. */
  private failedAt = new Map<string, number>();
  private tickNumber = 0;

  constructor(
    @Inject(PgOnecAlertNotificationsRepository) private readonly repository: PgOnecAlertNotificationsRepository,
    @Inject(PgOnecRepository) private readonly alerts: PgOnecRepository,
    @Inject(OnecAuditWriter) private readonly audit: OnecAuditWriter,
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
    @Optional() @Inject(WhatsAppNotificationPort) private readonly whatsapp?: WhatsAppNotificationPort,
  ) {}

  async tick(now = new Date()): Promise<NotifierTickResult> {
    const flagOn = this.runtime.get().alertNotifications === true;
    const { switchedOn, cutOff, afterGap } = await this.repository.syncActive(flagOn, ONEC_ALERT_DISPATCHER_GAP_MINUTES);
    if (switchedOn) {
      this.logger.log(`1C alert notifications switched on${afterGap ? ' after a dispatcher gap' : ''}; ${cutOff} waiting episode(s) go to the digest`);
    }
    if (!flagOn) return { active: false, switchedOn: false, dispatches: [] };

    const requestId = `${ONEC_ALERT_NOTIFIER_ACTOR}:${now.toISOString()}`;
    const dispatches: DispatchOutcome[] = [];
    let failure: string | null = null;
    try {
      const policies = new Map((await this.repository.listPolicies()).map((policy) => [policy.groupCode, policy] as const));
      const planned = planOnecAlertDispatches(await this.repository.listCandidates(), policies);
      this.tickNumber += 1;
      const plans = orderFairly(planned, this.failedAt);
      let sentCount = 0;
      let attempts = 0;
      for (const plan of plans) {
        if (sentCount >= ONEC_ALERT_DISPATCH_LIMITS.dispatchesPerTick || attempts >= ONEC_ALERT_DISPATCH_LIMITS.attemptsPerTick) break;
        attempts += 1;
        try {
          const outcome = await this.dispatch(plan, requestId);
          dispatches.push(outcome);
          if (outcome.kind === 'no_recipients') this.failedAt.set(planKey(plan), this.tickNumber);
          else this.failedAt.delete(planKey(plan));
          if (outcome.kind === 'sent') sentCount += 1;
        } catch (error) {
          failure = describe(error);
          this.failedAt.set(planKey(plan), this.tickNumber);
          this.logger.error(`1C alert dispatch ${plan.stage}/${plan.group} failed (retried next tick): ${failure}`);
        }
      }
      // Forget plans that no longer exist (their episodes were sent or closed meanwhile).
      const live = new Set(planned.map(planKey));
      for (const key of [...this.failedAt.keys()]) if (!live.has(key)) this.failedAt.delete(key);
      try {
        await this.maintainExternal(requestId);
      } catch (error) {
        failure = describe(error);
        this.logger.error(`1C alert external deliveries: ${failure}`);
      }
      await this.reportNoRecipients([...policies.values()]);
    } catch (error) {
      failure = describe(error);
      this.logger.error(`1C alert notifier tick failed: ${failure}`);
    }
    await this.repository.recordTick(failure);
    return { active: true, switchedOn, dispatches };
  }

  async dispatch(plan: PlannedDispatch, requestId: string): Promise<DispatchOutcome> {
    return this.repository.transaction(async (tx) => {
      // Lock order (plan §2.2): policy FOR SHARE → episodes FOR UPDATE → permissions_state/users FOR SHARE → inserts.
      const policy = await this.repository.lockPolicyShared(tx, plan.group);
      if (!policy) return { kind: 'nothing' };
      const members = (await this.repository.lockCandidates(tx, plan.episodeIds)).filter((episode) => nextStageOf(episode, policy) === plan.stage);
      if (members.length === 0) return { kind: 'nothing' };
      const chosen = chooseRecipients(await this.repository.lockRecipientCandidates(tx, policy));
      // Nobody to deliver to: nothing is recorded, the episodes keep waiting (plan §2.4 step 4).
      if (!chosen) return { kind: 'no_recipients', group: plan.group };

      const importance = maxImportance(members.map((episode) => effectiveImportance(policy.importance, episode.severityMax)));
      const now = new Date();
      const targets = this.whatsapp ? whatsappTargets(policy, chosen.users.map((user) => user.userId)) : [];
      // An alarm whose members all closed before this tick (opened and resolved between two ticks) still gets the bell
      // and the balloon, but no phone message: decided here, under the episode locks (R3-1). `resolved` is a notice.
      const allClosed = plan.stage !== 'resolved' && members.every((episode) => episode.resolvedAt !== null);
      // The delay holds back only the external part of an opening (plan §2.5); other stages go out with the minimum. A
      // recovery notice is decided by releaseDelayed (this tick, after the dispatches): it goes only where its alarm went.
      const recovery = plan.stage === 'resolved' && targets.length > 0;
      const delayed = targets.length > 0 && !allClosed && ((plan.stage === 'opened' && policy.delayMinutes > 0) || recovery);
      const externalState: OnecAlertExternalState =
        targets.length === 0 ? 'none' : allClosed ? 'suppressed' : delayed ? 'pending_delay' : 'queued';
      const dispatchId = await this.repository.insertDispatch(tx, {
        sourceId: plan.sourceId,
        group: plan.group,
        stage: plan.stage,
        importance,
        fallbackLevel: chosen.level,
        requestId,
        externalState,
        externalDueAt: delayed ? new Date(now.getTime() + (recovery ? 0 : policy.delayMinutes * 60_000)) : null,
      });
      await this.repository.insertMembers(
        tx,
        dispatchId,
        plan.stage,
        members.map((episode) => ({ episodeId: episode.episodeId, seq: plan.stage === 'reminder' ? episode.reminders + 1 : 1 })),
      );
      const text = buildOnecAlertText({
        stage: plan.stage,
        group: plan.group,
        importance,
        members: members.map((episode) => ({ ...episode, severity: episode.severityMax })),
      });
      const level = levelOf(plan.stage, importance);
      const rows: RecipientRowInput[] = [];
      for (const user of chosen.users) {
        const { notificationId } = await this.write.insertIfAbsent(tx, {
          userId: user.userId,
          level,
          title: text.title,
          message: text.message,
          entityType: ONEC_ALERT_DISPATCH_ENTITY,
          entityId: String(dispatchId),
          sourceType: ONEC_ALERT_NOTIFICATION_SOURCE,
          sourceId: String(dispatchId),
          idempotencyKey: `${ONEC_ALERT_NOTIFICATION_SOURCE}:${dispatchId}:${user.userId}`,
          balloonMode: 'mandatory',
        });
        rows.push({ channel: 'in_app', userId: user.userId, fallbackLevel: chosen.level, status: 'written', notificationId });
        rows.push({ channel: 'balloon', userId: user.userId, fallbackLevel: chosen.level, status: 'written', notificationId });
      }
      if (externalState === 'suppressed') {
        rows.push(...targets.map((target) => skippedRow(target, 'RESOLVED_BEFORE_SEND')));
      }
      if (externalState === 'queued') {
        rows.push(
          ...(await this.enqueueWhatsApp(tx, {
            dispatchId,
            stage: plan.stage,
            importance,
            policy,
            text,
            level,
            targets,
            attempt: 1,
            fallbackLevel: chosen.level,
            correlationId: requestId,
            now,
          })),
        );
      }
      await this.repository.insertRecipientRows(tx, dispatchId, rows);
      if (plan.stage === 'opened' || plan.stage === 'digest') {
        await this.repository.markNotified(tx, members.map((episode) => episode.episodeId));
      }
      await this.recordDispatched(tx, requestId, {
        dispatchId,
        plan,
        importance,
        members,
        recipients: chosen.users.length,
        fallbackLevel: chosen.level,
        whatsapp: externalCounts(rows),
        externalState,
      });
      return { kind: 'sent', dispatchId, recipients: chosen.users.length, fallbackLevel: chosen.level };
    });
  }

  private async recordDispatched(
    tx: DatabaseClient,
    requestId: string,
    input: {
      dispatchId: number;
      plan: PlannedDispatch;
      importance: OnecAlertImportance;
      members: EpisodeCandidate[];
      recipients: number;
      fallbackLevel: number;
      whatsapp: ExternalCounts;
      externalState: OnecAlertExternalState;
    },
  ): Promise<void> {
    const agents = [...new Set(input.members.map((episode) => episode.agentId).filter((id): id is string => Boolean(id)))];
    // Texts and addresses are not audited: only codes, counts and the normalized alert ids.
    await this.audit.bySystem(
      tx,
      ONEC_ALERT_NOTIFIER_ACTOR,
      requestId,
      {
        event: 'onec.alert_notification.dispatched',
        entityType: ONEC_ALERT_DISPATCH_ENTITY,
        entityId: input.dispatchId,
        stageCode: input.plan.stage,
        after: {
          group: input.plan.group,
          stage: input.plan.stage,
          importance: input.importance,
          members: input.members.length,
          kinds: [...new Set(input.members.map((episode) => episode.kind))].sort(),
          recipients: { in_app: input.recipients, balloon: input.recipients, whatsapp: input.whatsapp },
          fallbackLevel: input.fallbackLevel,
          externalState: input.externalState,
        },
        relatedEntities: input.members.map((episode) => ({ entityType: 'onec_alert', entityId: episode.alertId })),
      },
      { sourceId: input.plan.sourceId, agentId: agents.length === 1 ? agents[0] : null, correlationId: requestId },
    );
  }

  /**
   * One WhatsApp delivery per target through the channel's port, in the caller's transaction (plan §5). Each call is
   * isolated by a SAVEPOINT: an error rolls back only that call and is recorded as `skipped/ENQUEUE_FAILED`.
   */
  private async enqueueWhatsApp(
    tx: DatabaseClient,
    input: {
      dispatchId: number;
      stage: OnecAlertStage;
      importance: OnecAlertImportance;
      policy: Pick<OnecAlertPolicy, 'quietHours' | 'criticalIgnoresQuietHours'>;
      text: { title: string; message: string };
      level: 'info' | 'warning' | 'error';
      targets: readonly OnecAlertWhatsAppTarget[];
      attempt: number;
      fallbackLevel: number | null;
      correlationId: string;
      now: Date;
      /** A redelivered recovery notice keeps the lifetime of its first attempt (R1-2). */
      expiresAtCap?: Date | null;
    },
  ): Promise<RecipientRowInput[]> {
    const port = this.whatsapp;
    if (!port) return [];
    const computed = externalWindow({ stage: input.stage, importance: input.importance, policy: input.policy }, input.now);
    const window = input.expiresAtCap && input.expiresAtCap.getTime() < computed.expiresAt.getTime() ? { ...computed, expiresAt: input.expiresAtCap } : computed;
    const rows: RecipientRowInput[] = [];
    for (const target of input.targets) {
      const address = 'userId' in target ? { userId: target.userId, chatId: null } : { userId: null, chatId: target.chatId };
      const base = { channel: 'whatsapp' as const, ...address, attempt: input.attempt, fallbackLevel: 'userId' in target ? input.fallbackLevel : null, expiresAt: window.expiresAt };
      await tx.query('SAVEPOINT onec_alert_whatsapp');
      try {
        const recipient: WhatsAppNotificationRecipient = 'userId' in target ? { userId: target.userId } : { chatId: target.chatId };
        const result = await port.enqueue(tx, {
          idempotencyKey: whatsappKey(input.dispatchId, target, input.attempt),
          recipient,
          title: input.text.title,
          text: input.text.message,
          level: input.level,
          sourceType: ONEC_ALERT_NOTIFICATION_SOURCE,
          sourceId: input.dispatchId,
          correlationId: input.correlationId,
          notBefore: window.notBefore,
          expiresAt: window.expiresAt,
          requiredPermission: 'userId' in target ? WHATSAPP_REQUIRED_PERMISSION : null,
        });
        await tx.query('RELEASE SAVEPOINT onec_alert_whatsapp');
        const final = FINAL_CHANNEL_STATES.has(result.state);
        rows.push({
          ...base,
          status: result.state === 'skipped' ? 'skipped' : 'queued',
          skipReason: result.state === 'skipped' ? result.reason : null,
          channelDeliveryRef: result.deliveryId,
          channelState: final ? result.state : null,
          channelReason: final ? result.reason : null,
        });
      } catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT onec_alert_whatsapp');
        this.logger.error(`1C alert dispatch ${input.dispatchId}: WhatsApp enqueue failed: ${describe(error)}`);
        rows.push({ ...base, status: 'skipped', skipReason: 'ENQUEUE_FAILED' });
      }
    }
    return rows;
  }

  /** Delay release, cancellation on closing, watching and redelivery of the external part (plan §2.5). */
  private async maintainExternal(requestId: string): Promise<void> {
    if (!this.whatsapp) return;
    const limits = ONEC_ALERT_EXTERNAL_LIMITS;
    for (const dispatchId of await this.repository.dueDelayedDispatches(limits.releasesPerTick)) {
      await this.releaseDelayed(dispatchId, requestId);
    }
    for (const dispatchId of await this.repository.closedQueuedDispatches(limits.cancelsPerTick)) {
      await this.cancelClosed(dispatchId, requestId);
    }
    const watched = await this.repository.watchedExternalRows(limits.watchedPerTick);
    if (watched.length === 0) return;
    const statuses = new Map(
      (await this.whatsapp.statuses(this.repository.db, watched.map((row) => row.deliveryId as string))).map((status) => [status.deliveryId, status] as const),
    );
    const inFlight: number[] = [];
    for (const row of watched) {
      const status = statuses.get(row.deliveryId as string);
      if (!status || !FINAL_CHANNEL_STATES.has(status.state)) {
        inFlight.push(row.recipientRowId);
        continue;
      }
      if (status.state === 'cancelled' && status.reason !== null && REDELIVER_REASONS.has(status.reason) && row.attempt < limits.maxAttempts) {
        await this.redeliver(row, status.state, status.reason, requestId);
      } else {
        await this.repository.recordChannelState(this.repository.db, row.recipientRowId, status.state, status.reason);
      }
    }
    await this.repository.touchWatched(this.repository.db, inFlight);
  }

  /**
   * Lock order of the external part (plan §2.2, R1-1): policy FOR SHARE → member episodes FOR UPDATE (SKIP LOCKED —
   * a writer closing one right now defers this to the next tick) → dispatch FOR UPDATE. The decision then sees every
   * closing that committed, and a later one waits for this transaction (its cancellation follows on the next tick).
   */
  private async lockExternal(tx: DatabaseClient, dispatchId: number): Promise<{ dispatch: LockedDispatch; policy: OnecAlertPolicy | null } | null> {
    const group = await this.repository.dispatchGroup(tx, dispatchId);
    if (!group) return null;
    const policy = await this.repository.lockPolicyShared(tx, group);
    if (!(await this.repository.lockDispatchMembers(tx, dispatchId))) return null;
    const dispatch = await this.repository.lockDispatch(tx, dispatchId);
    return dispatch ? { dispatch, policy } : null;
  }

  private async releaseDelayed(dispatchId: number, requestId: string): Promise<void> {
    await this.repository.transaction(async (tx) => {
      const locked = await this.lockExternal(tx, dispatchId);
      if (!locked || locked.dispatch.externalState !== 'pending_delay') return;
      const { dispatch, policy } = locked;
      const members = await this.repository.dispatchMembers(tx, dispatchId);
      const users = await this.repository.inAppRecipients(tx, dispatchId);
      const targets = policy ? whatsappTargets(policy, users.map((user) => user.userId)) : [];
      const now = new Date();
      let rows: RecipientRowInput[];
      let state: OnecAlertExternalState;
      if (dispatch.stage === 'resolved' && policy && targets.length > 0) {
        // A recovery notice: only where its alarm went, about the episodes that alarm carried (recoveryPlan).
        const final = now.getTime() >= dispatch.createdAt.getTime() + ONEC_ALERT_RECOVERY_WAIT_MS;
        const plan = recoveryPlan(targets, members.map((episode) => episode.episodeId), await this.alarmOf(tx, members), final);
        if (plan.pending) {
          // An alarm is still in flight: look again on a later tick (no audit — nothing changed).
          await this.repository.postponeDelayed(tx, dispatchId, ONEC_ALERT_RECOVERY_RECHECK_SECONDS);
          return;
        }
        rows = plan.skip.map((target) => skippedRow(target, 'ALARM_NOT_SENT'));
        for (const send of plan.sends) {
          rows.push(
            ...(await this.enqueueWhatsApp(tx, {
              dispatchId,
              stage: dispatch.stage,
              importance: dispatch.importance,
              policy,
              text: this.textOf(dispatch, members.filter((episode) => send.episodeIds.includes(episode.episodeId))),
              level: levelOf(dispatch.stage, dispatch.importance),
              targets: send.targets,
              attempt: 1,
              fallbackLevel: users[0]?.fallbackLevel ?? null,
              correlationId: requestId,
              now,
            })),
          );
        }
        state = plan.sends.length > 0 ? 'queued' : 'suppressed';
      } else if (targets.length === 0 || !policy) {
        rows = [];
        state = 'suppressed';
      } else if (!externalStillRelevant(dispatch, members, now)) {
        // Everything closed before the delay was over: the bell and balloon stay, the phones are spared.
        state = 'suppressed';
        rows = targets.map((target) => skippedRow(target, 'RESOLVED_BEFORE_DELAY'));
      } else {
        state = 'queued';
        rows = await this.enqueueWhatsApp(tx, {
          dispatchId,
          stage: dispatch.stage,
          importance: dispatch.importance,
          policy,
          text: this.textOf(dispatch, members),
          level: levelOf(dispatch.stage, dispatch.importance),
          targets,
          attempt: 1,
          fallbackLevel: users[0]?.fallbackLevel ?? null,
          correlationId: requestId,
          now,
        });
      }
      await this.repository.insertRecipientRows(tx, dispatchId, rows);
      await this.repository.setExternalState(tx, dispatchId, state);
      await this.recordExternal(tx, requestId, dispatch, 'onec.alert_notification.external_released', { externalState: state, whatsapp: externalCounts(rows) });
    });
  }

  private async cancelClosed(dispatchId: number, requestId: string): Promise<void> {
    const port = this.whatsapp;
    if (!port) return;
    await this.repository.transaction(async (tx) => {
      const dispatch = await this.repository.lockDispatch(tx, dispatchId);
      if (!dispatch || dispatch.externalState !== 'queued' || dispatch.stage === 'resolved') return;
      const members = await this.repository.dispatchMembers(tx, dispatchId);
      if (members.some((member) => member.resolvedAt === null)) return;
      let cancelled = 0;
      for (const row of await this.repository.queuedExternalRows(tx, dispatchId)) {
        if (!row.deliveryId) continue;
        const result = await port.cancel(tx, { deliveryId: row.deliveryId });
        // Only our own cancellation is recorded here; a delivery that had already finished keeps being watched, so
        // the poller records the channel's state with its reason (R2-2).
        if (result?.cancelled) {
          cancelled += 1;
          await this.repository.recordChannelState(tx, row.recipientRowId, 'cancelled', 'cancelled_by_source');
        }
      }
      await this.repository.setExternalState(tx, dispatchId, 'cancelled');
      await this.recordExternal(tx, requestId, dispatch, 'onec.alert_notification.external_cancelled', { cancelled, reason: 'all_members_closed' });
    });
  }

  /** A new attempt of one recipient row after `delivery_gap`/`expired` (plan §2.5 redeliver); not a new dispatch. */
  private async redeliver(watched: ExternalRecipientRow, state: string, reason: string, requestId: string): Promise<void> {
    await this.repository.transaction(async (tx) => {
      const locked = await this.lockExternal(tx, watched.dispatchId);
      if (!locked) return;
      const { dispatch, policy } = locked;
      // Re-read after every lock: a PATCH or another path may have recorded this row meanwhile.
      const row = await this.repository.externalRow(tx, watched.recipientRowId);
      if (!row || row.status !== 'queued' || row.channelState !== null) return;
      const members = await this.repository.dispatchMembers(tx, dispatch.dispatchId);
      const firstExpiresAt = await this.repository.firstAttemptExpiresAt(tx, dispatch.dispatchId, row);
      const now = new Date();
      const target: OnecAlertWhatsAppTarget | null = row.userId !== null ? { userId: row.userId } : row.chatId !== null ? { chatId: row.chatId } : null;
      // Still wanted: the dispatch is relevant and the policy still sends this target (a removed channel or a changed
      // chat is not redelivered).
      const wanted =
        target !== null &&
        policy !== null &&
        dispatch.externalState === 'queued' &&
        externalStillRelevant(dispatch, members, now, firstExpiresAt) &&
        whatsappTargets(policy, row.userId !== null ? [row.userId] : []).some((t) => JSON.stringify(t) === JSON.stringify(target));
      // A recovery notice whose first lifetime ends before its quiet hours do cannot be sent any more.
      const startsInTime =
        dispatch.stage !== 'resolved' || !firstExpiresAt || !policy ||
        Math.max(now.getTime(), externalWindow({ stage: dispatch.stage, importance: dispatch.importance, policy }, now).notBefore?.getTime() ?? 0) < firstExpiresAt.getTime();
      if (!wanted || !startsInTime || !target || !policy) {
        await this.repository.recordChannelState(tx, row.recipientRowId, state, reason);
        return;
      }
      // A recovery notice is about the episodes whose alarm reached this target, as on its first attempt.
      const about =
        dispatch.stage === 'resolved'
          ? recoveryPlan([target], members.map((episode) => episode.episodeId), await this.alarmOf(tx, members), true)
              .sends[0]?.episodeIds ?? []
          : members.map((episode) => episode.episodeId);
      if (about.length === 0) {
        await this.repository.recordChannelState(tx, row.recipientRowId, state, reason);
        return;
      }
      await this.repository.supersede(tx, row.recipientRowId, state, reason);
      const rows = await this.enqueueWhatsApp(tx, {
        dispatchId: dispatch.dispatchId,
        stage: dispatch.stage,
        importance: dispatch.importance,
        policy,
        text: this.textOf(dispatch, members.filter((episode) => about.includes(episode.episodeId))),
        level: levelOf(dispatch.stage, dispatch.importance),
        targets: [target],
        attempt: row.attempt + 1,
        fallbackLevel: null,
        correlationId: requestId,
        now,
        expiresAtCap: dispatch.stage === 'resolved' ? firstExpiresAt : null,
      });
      await this.repository.insertRecipientRows(tx, dispatch.dispatchId, rows);
      await this.recordExternal(tx, requestId, dispatch, 'onec.alert_notification.external_redelivered', {
        attempt: row.attempt + 1,
        previous: { state, reason },
        whatsapp: externalCounts(rows),
      });
    });
  }

  /**
   * The alarm deliveries of these episodes with the channel's own word on the rows still in flight here (R5-2-1): the
   * poll that records it may be behind (≤ 200 rows a tick, or the dispatcher stood still), and a recovery notice must
   * not give up on an alarm the channel already sent. Only read, not recorded — the poll records it, and a delivery
   * the channel cancelled for a restart or by its lifetime stays in flight while it may still be redelivered.
   */
  private async alarmOf(tx: DatabaseClient, members: readonly EpisodeCandidate[]): Promise<AlarmDelivery> {
    const alarm = await this.repository.alarmDeliveries(tx, members.map((episode) => episode.episodeId));
    const ids = [...new Set(alarm.rows.filter((row) => row.channelState === null && row.deliveryId).map((row) => row.deliveryId as string))];
    if (!this.whatsapp || ids.length === 0) return alarm;
    const known = new Map<string, { state: string; reason: string | null }>();
    for (let i = 0; i < ids.length; i += 500) {
      for (const status of await this.whatsapp.statuses(tx, ids.slice(i, i + 500))) known.set(status.deliveryId, status);
    }
    return {
      ...alarm,
      rows: alarm.rows.map((row) => {
        const status = row.channelState === null && row.deliveryId ? known.get(row.deliveryId) : undefined;
        if (!status || !FINAL_CHANNEL_STATES.has(status.state)) return row;
        const redeliverable = status.state === 'cancelled' && status.reason !== null && REDELIVER_REASONS.has(status.reason) && row.attempt < ONEC_ALERT_EXTERNAL_LIMITS.maxAttempts;
        return redeliverable ? row : { ...row, channelState: status.state, channelReason: status.reason };
      }),
    };
  }

  private textOf(dispatch: LockedDispatch, members: readonly EpisodeCandidate[]): { title: string; message: string } {
    return buildOnecAlertText({
      stage: dispatch.stage,
      group: dispatch.group,
      importance: dispatch.importance,
      members: members.map((episode) => ({ ...episode, severity: episode.severityMax })),
    });
  }

  private async recordExternal(tx: DatabaseClient, requestId: string, dispatch: LockedDispatch, event: string, after: Record<string, unknown>): Promise<void> {
    await this.audit.bySystem(
      tx,
      ONEC_ALERT_NOTIFIER_ACTOR,
      requestId,
      {
        event,
        entityType: ONEC_ALERT_DISPATCH_ENTITY,
        entityId: dispatch.dispatchId,
        stageCode: dispatch.stage,
        after: { group: dispatch.group, stage: dispatch.stage, channel: 'whatsapp', ...after },
      },
      { sourceId: dispatch.sourceId, agentId: null, correlationId: requestId },
    );
  }

  /**
   * «Оповещения 1С некому доставить» (plan §2.4): a critical alert on the «1С» screen while ANY group has nobody in its
   * recipient chain, checked every tick for all groups — not from the attempts of this tick, which a budget may cut
   * short (R3-2). Written after the dispatch transactions (writers lock onec_alerts before episodes, the dispatcher
   * never the other way).
   */
  private async reportNoRecipients(policies: readonly OnecAlertPolicy[]): Promise<void> {
    const groups: OnecAlertGroupCode[] = [];
    for (const policy of policies) {
      if (!chooseRecipients(await this.repository.previewRecipientCandidates(policy))) groups.push(policy.groupCode);
    }
    groups.sort();
    if (groups.length > 0) {
      await this.alerts.transaction((tx) =>
        this.alerts.upsertAlert(tx, {
          kind: NO_RECIPIENTS_ALERT_KIND,
          agentId: null,
          sourceId: null,
          certId: null,
          severity: 'critical',
          dedupeKey: NO_RECIPIENTS_DEDUPE_KEY,
          details: { groups },
        }),
      );
      this.logger.error(`1C alert notifications have no recipients for: ${groups.join(', ')}`);
      return;
    }
    await this.alerts.transaction((tx) => this.alerts.resolveAlertByDedupeKey(tx, NO_RECIPIENTS_DEDUPE_KEY));
  }
}

/** A WhatsApp row that is not handed to the channel (everything closed already). */
function skippedRow(target: OnecAlertWhatsAppTarget, reason: string): RecipientRowInput {
  return {
    channel: 'whatsapp',
    ...('userId' in target ? { userId: target.userId, chatId: null } : { userId: null, chatId: target.chatId }),
    fallbackLevel: null,
    status: 'skipped',
    skipReason: reason,
  };
}

type ExternalCounts = { queued: number; skipped: number; chat: boolean };

/** Counts of the WhatsApp rows for the audit (no addresses). */
function externalCounts(rows: readonly RecipientRowInput[]): ExternalCounts {
  const whatsapp = rows.filter((row) => row.channel === 'whatsapp');
  return {
    queued: whatsapp.filter((row) => row.status === 'queued').length,
    skipped: whatsapp.filter((row) => row.status === 'skipped').length,
    chat: whatsapp.some((row) => row.chatId),
  };
}

function levelOf(stage: OnecAlertStage, importance: OnecAlertImportance): 'info' | 'warning' | 'error' {
  return stage === 'resolved' ? 'info' : levelForImportance(importance);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

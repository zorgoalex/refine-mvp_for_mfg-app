import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DatabaseClient } from '../../../database/database.types';
import { PgNotificationWriteAdapter } from '../../notifications-engine/adapters/pg-notification-write';
import { ONEC_ALERT_NOTIFICATION_SOURCE } from '../../notifications-engine/domain/notification-event-registry';
import {
  PgOnecAlertNotificationsRepository,
  type EpisodeCandidate,
  type OnecAlertPolicy,
  type RecipientCandidate,
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
 * External channels (Telegram, WhatsApp) come in later slices.
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
      const dispatchId = await this.repository.insertDispatch(tx, {
        sourceId: plan.sourceId,
        group: plan.group,
        stage: plan.stage,
        importance,
        fallbackLevel: chosen.level,
        requestId,
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
      const level = plan.stage === 'resolved' ? 'info' : levelForImportance(importance);
      const rows: { channel: 'in_app' | 'balloon'; userId: number; fallbackLevel: number; notificationId: string }[] = [];
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
        rows.push({ channel: 'in_app', userId: user.userId, fallbackLevel: chosen.level, notificationId });
        rows.push({ channel: 'balloon', userId: user.userId, fallbackLevel: chosen.level, notificationId });
      }
      await this.repository.insertRecipientRows(tx, dispatchId, rows);
      if (plan.stage === 'opened' || plan.stage === 'digest') {
        await this.repository.markNotified(tx, members.map((episode) => episode.episodeId));
      }
      await this.recordDispatched(tx, requestId, { dispatchId, plan, importance, members, recipients: chosen.users.length, fallbackLevel: chosen.level });
      return { kind: 'sent', dispatchId, recipients: chosen.users.length, fallbackLevel: chosen.level };
    });
  }

  private async recordDispatched(
    tx: DatabaseClient,
    requestId: string,
    input: { dispatchId: number; plan: PlannedDispatch; importance: OnecAlertImportance; members: EpisodeCandidate[]; recipients: number; fallbackLevel: number },
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
          recipients: { in_app: input.recipients, balloon: input.recipients },
          fallbackLevel: input.fallbackLevel,
        },
        relatedEntities: input.members.map((episode) => ({ entityType: 'onec_alert', entityId: episode.alertId })),
      },
      { sourceId: input.plan.sourceId, agentId: agents.length === 1 ? agents[0] : null, correlationId: requestId },
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

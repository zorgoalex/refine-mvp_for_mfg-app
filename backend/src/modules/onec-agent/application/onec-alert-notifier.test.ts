import { describe, expect, it } from 'vitest';
import type { EpisodeCandidate, OnecAlertPolicy, RecipientCandidate } from '../adapters/pg-onec-alert-notifications-repository';
import type { OnecAlertGroupCode } from '../domain/onec-alert-groups';
import { ONEC_ALERT_DISPATCH_LIMITS, OnecAlertNotifier, chooseRecipients, nextStageOf, orderFairly, planKey, planOnecAlertDispatches } from './onec-alert-notifier';

const policy = (group: OnecAlertGroupCode, patch: Partial<OnecAlertPolicy> = {}): OnecAlertPolicy => ({
  groupCode: group,
  importance: 'auto',
  recipientRoleCodes: [],
  recipientUserIds: [],
  externalChannels: [],
  whatsappChatId: null,
  whatsappChatName: null,
  delayMinutes: 0,
  repeatMinutes: 120,
  notifyResolved: true,
  quietHours: null,
  criticalIgnoresQuietHours: true,
  version: 1,
  updatedBy: null,
  updatedByName: null,
  updatedAt: '2026-10-19T00:00:00.000Z',
  ...patch,
});

let nextId = 1;
const episode = (patch: Partial<EpisodeCandidate> = {}): EpisodeCandidate => ({
  episodeId: nextId++,
  alertId: 1,
  kind: 'agent_silent',
  status: 'pending',
  severityMax: 'critical',
  openedAt: new Date('2026-10-19T10:00:00Z'),
  acknowledgedAt: null,
  resolvedAt: null,
  sourceId: 1,
  sourceName: 'unf',
  agentId: 'unf-kz-test-01',
  details: {},
  ageSeconds: 5,
  firstImportance: null,
  hasEscalated: false,
  hasResolved: false,
  reminders: 0,
  sinceLastStageSeconds: null,
  ...patch,
});

const notified = (patch: Partial<EpisodeCandidate> = {}) =>
  episode({ status: 'notified', firstImportance: 'critical', sinceLastStageSeconds: 60, ...patch });

describe('nextStageOf (plan §2.5)', () => {
  const critical = policy('agent_offline', { importance: 'critical' });

  it('opens pending episodes and digests open ones cut off at enabling', () => {
    expect(nextStageOf(episode(), critical)).toBe('opened');
    expect(nextStageOf(episode({ status: 'closed_unnotified' }), critical)).toBe('digest');
    expect(nextStageOf(episode({ status: 'closed_unnotified', resolvedAt: new Date() }), critical)).toBeNull();
  });

  it('announces the recovery once, only when the policy asks for it', () => {
    const resolved = notified({ resolvedAt: new Date() });
    expect(nextStageOf(resolved, critical)).toBe('resolved');
    expect(nextStageOf({ ...resolved, hasResolved: true }, critical)).toBeNull();
    expect(nextStageOf(resolved, policy('agent_offline', { notifyResolved: false }))).toBeNull();
  });

  it('escalates once when an «auto» group grows to critical', () => {
    const grown = notified({ kind: 'agent_state', firstImportance: 'important', severityMax: 'critical' });
    expect(nextStageOf(grown, policy('agent_state'))).toBe('escalated');
    expect(nextStageOf({ ...grown, hasEscalated: true, sinceLastStageSeconds: 0 }, policy('agent_state'))).toBeNull();
    expect(nextStageOf(grown, policy('agent_state', { importance: 'important' }))).toBeNull();
  });

  it('reminds about critical open unaccepted alerts every repeat interval, at most 12 times', () => {
    expect(nextStageOf(notified({ sinceLastStageSeconds: 7199 }), critical)).toBeNull();
    expect(nextStageOf(notified({ sinceLastStageSeconds: 7200 }), critical)).toBe('reminder');
    expect(nextStageOf(notified({ sinceLastStageSeconds: 7200, acknowledgedAt: new Date() }), critical)).toBeNull();
    expect(nextStageOf(notified({ sinceLastStageSeconds: 7200, reminders: ONEC_ALERT_DISPATCH_LIMITS.maxReminders }), critical)).toBeNull();
    expect(nextStageOf(notified({ sinceLastStageSeconds: 7200 }), policy('agent_offline', { repeatMinutes: null }))).toBeNull();
    // An important (not critical) alert is not repeated.
    expect(nextStageOf(notified({ kind: 'etl_entity_failed', severityMax: 'warning', firstImportance: 'important', sinceLastStageSeconds: 99999 }), policy('sync'))).toBeNull();
  });
});

describe('planOnecAlertDispatches', () => {
  const policies = new Map<OnecAlertGroupCode, OnecAlertPolicy>(
    (['agent_offline', 'agent_state', 'sync', 'commands', 'config_source', 'certificate', 'stock_snapshots', 'other'] as const).map((g) => [g, policy(g)]),
  );

  it('aggregates the openings of one group and source into one dispatch after the window', () => {
    const fresh = [episode({ kind: 'etl_entity_failed', ageSeconds: 30 }), episode({ kind: 'etl_run_abandoned', ageSeconds: 10 })];
    expect(planOnecAlertDispatches(fresh, policies)).toEqual([]);
    const ready = [episode({ kind: 'etl_entity_failed', ageSeconds: 121 }), episode({ kind: 'etl_run_abandoned', ageSeconds: 10 })];
    const plans = planOnecAlertDispatches(ready, policies);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ group: 'sync', stage: 'opened', sourceId: 1, episodeIds: ready.map((e) => e.episodeId) });
  });

  it('sends the agent-offline group at once and keeps sources apart', () => {
    const plans = planOnecAlertDispatches([episode({ sourceId: 1 }), episode({ sourceId: 2 })], policies);
    expect(plans.map((plan) => plan.sourceId).sort()).toEqual([1, 2]);
  });

  it('splits 44+ episodes by 200 and puts openings before reminders', () => {
    const many = Array.from({ length: 450 }, () => episode({ kind: 'etl_entity_failed', ageSeconds: 500 }));
    const reminder = notified({ sinceLastStageSeconds: 99999 });
    const plans = planOnecAlertDispatches([reminder, ...many], policies);
    expect(plans.map((plan) => [plan.stage, plan.episodeIds.length])).toEqual([
      ['opened', 200],
      ['opened', 200],
      ['opened', 50],
      ['reminder', 1],
    ]);
  });
});

describe('chooseRecipients (plan §2.4)', () => {
  const user = (userId: number, patch: Partial<RecipientCandidate>): RecipientCandidate => ({
    userId,
    username: `u${userId}`,
    configured: false,
    manage: false,
    superadmin: false,
    ...patch,
  });

  it('falls back configured → onec.manage → superadmins → nobody', () => {
    expect(chooseRecipients([user(1, { configured: true }), user(2, { manage: true })])).toEqual({ level: 1, users: [user(1, { configured: true })] });
    expect(chooseRecipients([user(2, { manage: true }), user(3, { superadmin: true })])).toEqual({ level: 2, users: [user(2, { manage: true })] });
    expect(chooseRecipients([user(3, { superadmin: true })])).toEqual({ level: 3, users: [user(3, { superadmin: true })] });
    expect(chooseRecipients([])).toBeNull();
  });
});

describe('fair queue across ticks (R2-2)', () => {
  it('40 always-undeliverable plans cannot keep the 41st from its turn', async () => {
    const policies = (['agent_offline', 'agent_state', 'sync', 'commands', 'config_source', 'certificate', 'stock_snapshots', 'other'] as const).map((g) => policy(g));
    // 40 critical digests of different sources (planned first), then an important digest of «sync».
    const candidates = [
      ...Array.from({ length: 40 }, (_, i) => episode({ status: 'closed_unnotified', sourceId: 100 + i })),
      episode({ status: 'closed_unnotified', kind: 'etl_entity_failed', severityMax: 'warning', sourceId: 999 }),
    ];
    const repository = {
      syncActive: async () => ({ switchedOn: false, cutOff: 0, afterGap: false }),
      listPolicies: async () => policies,
      listCandidates: async () => candidates,
      recordTick: async () => undefined,
    };
    const runtime = { get: () => ({ alertNotifications: true }) };
    const notifier = new OnecAlertNotifier(repository as never, {} as never, {} as never, runtime as never);
    const delivered: (number | null)[] = [];
    notifier.dispatch = async (plan) => {
      if (plan.sourceId === 999) {
        delivered.push(plan.sourceId);
        return { kind: 'sent', dispatchId: 1, recipients: 1, fallbackLevel: 1 };
      }
      return { kind: 'no_recipients', group: plan.group };
    };
    (notifier as unknown as { reportNoRecipients: () => Promise<void> }).reportNoRecipients = async () => undefined;
    for (let tick = 0; tick < 4 && delivered.length === 0; tick += 1) await notifier.tick();
    expect(delivered).toEqual([999]);
  });

  it('orders never-failed plans first, then failed ones by their last attempt', () => {
    const plan = (sourceId: number) => ({ group: 'sync' as const, sourceId, stage: 'digest' as const, episodeIds: [sourceId] });
    const failed = new Map([[planKey(plan(1)), 2], [planKey(plan(2)), 1]]);
    expect(orderFairly([plan(1), plan(2), plan(3)], failed).map((p) => p.sourceId)).toEqual([3, 2, 1]);
  });
});

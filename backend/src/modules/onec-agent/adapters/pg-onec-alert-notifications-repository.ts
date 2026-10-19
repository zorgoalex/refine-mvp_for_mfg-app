import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import { ONEC_ALERT_KINDS } from '../domain/onec-alert-groups';
import type {
  OnecAlertGroupCode,
  OnecAlertImportance,
  OnecAlertPolicyImportance,
  OnecAlertSeverity,
  OnecAlertStage,
} from '../domain/onec-alert-groups';

/** One row of onec_alert_notification_policies. */
export interface OnecAlertPolicy {
  groupCode: OnecAlertGroupCode;
  importance: OnecAlertPolicyImportance;
  recipientRoleCodes: string[];
  recipientUserIds: number[];
  externalChannels: ('telegram' | 'whatsapp')[];
  whatsappChatId: string | null;
  whatsappChatName: string | null;
  delayMinutes: number;
  repeatMinutes: number | null;
  notifyResolved: boolean;
  quietHours: string | null;
  criticalIgnoresQuietHours: boolean;
  version: number;
  updatedBy: number | null;
  updatedByName: string | null;
  updatedAt: string;
}

export interface OnecAlertNotificationState {
  active: boolean;
  enabledAt: Date | null;
  lastTickAt: Date | null;
  lastTickError: string | null;
}

/** An episode with everything the dispatcher needs to pick its next stage (plan §2.5). */
export interface EpisodeCandidate {
  episodeId: number;
  alertId: number;
  kind: string;
  status: 'pending' | 'notified' | 'suppressed' | 'closed_unnotified';
  severityMax: OnecAlertSeverity;
  openedAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  sourceId: number | null;
  sourceName: string | null;
  agentId: string | null;
  details: Record<string, unknown>;
  /** Seconds since the episode was written (aggregation window of the opening). */
  ageSeconds: number;
  /** Importance of the first dispatch (`opened` or `digest`); null — none yet. */
  firstImportance: OnecAlertImportance | null;
  hasEscalated: boolean;
  hasResolved: boolean;
  reminders: number;
  /** Seconds since the latest dispatch this episode was part of; null — none. */
  sinceLastStageSeconds: number | null;
}

export interface RecipientCandidate {
  userId: number;
  username: string;
  configured: boolean;
  manage: boolean;
  superadmin: boolean;
}

export interface RecentDispatchRow {
  dispatchId: number;
  groupCode: OnecAlertGroupCode;
  stage: OnecAlertStage;
  importance: OnecAlertImportance;
  sourceId: number | null;
  fallbackLevel: number;
  createdAt: string;
  members: number;
  kinds: string[];
  recipients: { userId: number; username: string | null; shown: boolean; read: boolean }[];
}

interface PolicyRow {
  group_code: OnecAlertGroupCode;
  importance: OnecAlertPolicyImportance;
  recipient_role_codes: string[];
  recipient_user_ids: (string | number)[];
  external_channels: ('telegram' | 'whatsapp')[];
  whatsapp_chat_id: string | null;
  whatsapp_chat_name: string | null;
  delay_minutes: number;
  repeat_minutes: number | null;
  notify_resolved: boolean;
  quiet_hours: string | null;
  critical_ignores_quiet_hours: boolean;
  version: number;
  updated_by: string | number | null;
  updated_by_name: string | null;
  updated_at: Date;
}

const POLICY_COLUMNS = `p.group_code, p.importance, p.recipient_role_codes, p.recipient_user_ids, p.external_channels,
  p.whatsapp_chat_id, p.whatsapp_chat_name, p.delay_minutes, p.repeat_minutes, p.notify_resolved, p.quiet_hours,
  p.critical_ignores_quiet_hours, p.version, p.updated_by, p.updated_at`;

function mapPolicy(row: PolicyRow): OnecAlertPolicy {
  return {
    groupCode: row.group_code,
    importance: row.importance,
    recipientRoleCodes: row.recipient_role_codes ?? [],
    recipientUserIds: (row.recipient_user_ids ?? []).map(Number),
    externalChannels: row.external_channels ?? [],
    whatsappChatId: row.whatsapp_chat_id,
    whatsappChatName: row.whatsapp_chat_name,
    delayMinutes: Number(row.delay_minutes),
    repeatMinutes: row.repeat_minutes === null ? null : Number(row.repeat_minutes),
    notifyResolved: row.notify_resolved,
    quietHours: row.quiet_hours,
    criticalIgnoresQuietHours: row.critical_ignores_quiet_hours,
    version: Number(row.version),
    updatedBy: row.updated_by === null ? null : Number(row.updated_by),
    updatedByName: row.updated_by_name ?? null,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/*
 * Selection of the dispatcher (plan §2.5): episodes that may still need a stage. Pending openings, open episodes
 * cut off at enabling (digest), notified episodes that are open (escalation, reminders) or recently resolved without
 * their `resolved` stage. Prior stages come from the dispatcher's own journal (members are written only by it).
 */
const candidatesSql = (extraColumns = '') => `
  SELECT ${extraColumns} e.episode_id, e.alert_id, e.kind, e.status, e.severity_max, e.opened_at, e.acknowledged_at, e.resolved_at,
         a.source_id, s.display_name AS source_name, a.agent_id, COALESCE(a.details, '{}'::jsonb) AS details,
         EXTRACT(EPOCH FROM (now() - e.created_at))::float8 AS age_seconds,
         (SELECT d.importance FROM onec_alert_dispatch_members m JOIN onec_alert_dispatches d USING (dispatch_id)
           WHERE m.episode_id = e.episode_id AND m.stage IN ('opened', 'digest') ORDER BY d.dispatch_id LIMIT 1) AS first_importance,
         EXISTS (SELECT 1 FROM onec_alert_dispatch_members m WHERE m.episode_id = e.episode_id AND m.stage = 'escalated') AS has_escalated,
         EXISTS (SELECT 1 FROM onec_alert_dispatch_members m WHERE m.episode_id = e.episode_id AND m.stage = 'resolved') AS has_resolved,
         (SELECT count(*) FROM onec_alert_dispatch_members m WHERE m.episode_id = e.episode_id AND m.stage = 'reminder')::int AS reminders,
         (SELECT EXTRACT(EPOCH FROM (now() - max(d.created_at)))::float8 FROM onec_alert_dispatch_members m
            JOIN onec_alert_dispatches d USING (dispatch_id) WHERE m.episode_id = e.episode_id) AS since_last_stage_seconds
    FROM onec_alert_episodes e
    LEFT JOIN onec_alerts a ON a.alert_id = e.alert_id
    LEFT JOIN onec_sources s ON s.source_id = a.source_id`;
const CANDIDATES_SQL = candidatesSql();

interface CandidateRow {
  episode_id: string | number;
  alert_id: string | number;
  kind: string;
  status: EpisodeCandidate['status'];
  severity_max: OnecAlertSeverity;
  opened_at: Date;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
  source_id: string | number | null;
  source_name: string | null;
  agent_id: string | null;
  details: Record<string, unknown> | null;
  age_seconds: number;
  first_importance: OnecAlertImportance | null;
  has_escalated: boolean;
  has_resolved: boolean;
  reminders: number;
  since_last_stage_seconds: number | null;
}

function mapCandidate(row: CandidateRow): EpisodeCandidate {
  return {
    episodeId: Number(row.episode_id),
    alertId: Number(row.alert_id),
    kind: row.kind,
    status: row.status,
    severityMax: row.severity_max,
    openedAt: new Date(row.opened_at),
    acknowledgedAt: row.acknowledged_at ? new Date(row.acknowledged_at) : null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
    sourceId: row.source_id === null ? null : Number(row.source_id),
    sourceName: row.source_name,
    agentId: row.agent_id,
    details: row.details ?? {},
    ageSeconds: Number(row.age_seconds),
    firstImportance: row.first_importance,
    hasEscalated: row.has_escalated,
    hasResolved: row.has_resolved,
    reminders: Number(row.reminders),
    sinceLastStageSeconds: row.since_last_stage_seconds === null ? null : Number(row.since_last_stage_seconds),
  };
}

/** How long a resolved episode stays a candidate for its `resolved` stage (a dispatcher outage longer than that drops it). */
const RESOLVED_LOOKBACK = '7 days';
const CANDIDATE_LIMIT_PER_GROUP = 400;
/** Same bound as the dispatcher (plan §2.5). */
const MAX_REMINDERS = 12;

@Injectable()
export class PgOnecAlertNotificationsRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  transaction<T>(handler: (tx: DatabaseClient) => Promise<T>): Promise<T> {
    return this.database.transaction(handler);
  }

  get db(): DatabaseClient {
    return this.database;
  }

  // ---------------------------------------------------------------- state

  async readState(client: DatabaseClient = this.database): Promise<OnecAlertNotificationState> {
    const { rows } = await client.query<{ active: boolean; enabled_at: Date | null; last_tick_at: Date | null; last_tick_error: string | null }>(
      `SELECT active, enabled_at, last_tick_at, last_tick_error FROM onec_alert_notification_state WHERE id`,
    );
    const row = rows[0];
    return {
      active: row?.active ?? false,
      enabledAt: row?.enabled_at ?? null,
      lastTickAt: row?.last_tick_at ?? null,
      lastTickError: row?.last_tick_error ?? null,
    };
  }

  /**
   * Follows the flag (plan §2.10). Switching on is the cutoff: every episode still waiting for its opening is marked
   * `closed_unnotified` — they are not sent one by one; the open ones get one digest per group. Switching off stops
   * new stages. A dispatcher that has not ticked for `gapMinutes` while marked active (backend down, or an image
   * below slice 1 ran meanwhile and never cleared `active`) is treated as switched off: the next tick cuts off again,
   * so what piled up arrives as one digest per group, not as an avalanche (R1-4). Returns whether this call switched
   * the dispatcher on.
   */
  async syncActive(flagOn: boolean, gapMinutes: number): Promise<{ switchedOn: boolean; cutOff: number; afterGap: boolean }> {
    return this.database.transaction(async (tx) => {
      const { rows } = await tx.query<{ active: boolean; stale: boolean }>(
        `SELECT active, (last_tick_at IS NOT NULL AND last_tick_at < now() - make_interval(mins => $1)) AS stale
           FROM onec_alert_notification_state WHERE id FOR UPDATE`,
        [gapMinutes],
      );
      const wasActive = rows[0]?.active ?? false;
      const afterGap = flagOn && wasActive && rows[0]?.stale === true;
      const active = afterGap ? false : wasActive;
      if (flagOn === active) return { switchedOn: false, cutOff: 0, afterGap: false };
      if (!flagOn) {
        await tx.query(`UPDATE onec_alert_notification_state SET active = false, updated_at = now() WHERE id`);
        return { switchedOn: false, cutOff: 0, afterGap: false };
      }
      await tx.query(`UPDATE onec_alert_notification_state SET active = true, enabled_at = now(), updated_at = now() WHERE id`);
      const cut = await tx.query(
        `UPDATE onec_alert_episodes SET status = 'closed_unnotified', updated_at = now() WHERE status = 'pending'`,
      );
      return { switchedOn: true, cutOff: cut.rowCount ?? 0, afterGap };
    });
  }

  async recordTick(error: string | null): Promise<void> {
    await this.database.query(
      `UPDATE onec_alert_notification_state SET last_tick_at = now(), last_tick_error = $1, updated_at = now() WHERE id`,
      [error === null ? null : error.slice(0, 500)],
    );
  }

  // ---------------------------------------------------------------- policies

  async listPolicies(client: DatabaseClient = this.database): Promise<OnecAlertPolicy[]> {
    const { rows } = await client.query<PolicyRow>(
      `SELECT ${POLICY_COLUMNS}, u.username AS updated_by_name
         FROM onec_alert_notification_policies p
         LEFT JOIN users u ON u.user_id = p.updated_by
        ORDER BY p.group_code`,
    );
    return rows.map(mapPolicy);
  }

  /** Dispatcher side of the lock order (plan §2.2): the policy row FOR SHARE until the dispatch commits. */
  async lockPolicyShared(tx: DatabaseClient, group: OnecAlertGroupCode): Promise<OnecAlertPolicy | null> {
    const { rows } = await tx.query<PolicyRow>(
      `SELECT ${POLICY_COLUMNS}, NULL::text AS updated_by_name
         FROM onec_alert_notification_policies p WHERE p.group_code = $1 FOR SHARE`,
      [group],
    );
    return rows[0] ? mapPolicy(rows[0]) : null;
  }

  /** PATCH side of the lock order: the policy row FOR UPDATE. */
  async lockPolicyForUpdate(tx: DatabaseClient, group: OnecAlertGroupCode): Promise<OnecAlertPolicy | null> {
    const { rows } = await tx.query<PolicyRow>(
      `SELECT ${POLICY_COLUMNS}, NULL::text AS updated_by_name
         FROM onec_alert_notification_policies p WHERE p.group_code = $1 FOR UPDATE`,
      [group],
    );
    return rows[0] ? mapPolicy(rows[0]) : null;
  }

  async updatePolicy(
    tx: DatabaseClient,
    group: OnecAlertGroupCode,
    next: Pick<OnecAlertPolicy, 'importance' | 'recipientRoleCodes' | 'recipientUserIds' | 'externalChannels' | 'delayMinutes' | 'repeatMinutes' | 'notifyResolved' | 'quietHours' | 'criticalIgnoresQuietHours'>,
    actorId: number,
  ): Promise<void> {
    await tx.query(
      `UPDATE onec_alert_notification_policies
          SET importance = $2, recipient_role_codes = $3::text[], recipient_user_ids = $4::bigint[], external_channels = $5::text[],
              delay_minutes = $6, repeat_minutes = $7, notify_resolved = $8, quiet_hours = $9, critical_ignores_quiet_hours = $10,
              version = version + 1, updated_by = $11, updated_at = now()
        WHERE group_code = $1`,
      [group, next.importance, next.recipientRoleCodes, next.recipientUserIds, next.externalChannels, next.delayMinutes,
        next.repeatMinutes, next.notifyResolved, next.quietHours, next.criticalIgnoresQuietHours, actorId],
    );
  }

  async existingRoleCodes(client: DatabaseClient, codes: readonly string[]): Promise<string[]> {
    if (codes.length === 0) return [];
    const { rows } = await client.query<{ role_code: string }>(`SELECT role_code FROM roles WHERE role_code = ANY($1::text[])`, [codes]);
    return rows.map((row) => row.role_code);
  }

  async existingUserIds(client: DatabaseClient, ids: readonly number[]): Promise<number[]> {
    if (ids.length === 0) return [];
    const { rows } = await client.query<{ user_id: string }>(`SELECT user_id::text FROM users WHERE user_id = ANY($1::bigint[])`, [ids]);
    return rows.map((row) => Number(row.user_id));
  }

  // ---------------------------------------------------------------- candidates and dispatches

  /**
   * Candidates of the dispatcher, one bounded query per stage (R1-2, R2-1). Each query applies the same readiness
   * rule as `nextStageOf`, including the group's policy (importance, repeat, recovery notice), BEFORE its limit — so
   * episodes that need nothing now never fill a page ahead of one that does. Only the aggregation window of an
   * opening is left to the planner; pending episodes are young (window ≤ 120 s) and leave the page quickly.
   */
  async listCandidates(client: DatabaseClient = this.database): Promise<EpisodeCandidate[]> {
    const member = (stage: string) =>
      `EXISTS (SELECT 1 FROM onec_alert_dispatch_members m WHERE m.episode_id = e.episode_id AND m.stage = '${stage}')`;
    const lastStage = `(SELECT max(d.created_at) FROM onec_alert_dispatch_members m JOIN onec_alert_dispatches d USING (dispatch_id)
                         WHERE m.episode_id = e.episode_id)`;
    const first = `(SELECT d.importance FROM onec_alert_dispatch_members m JOIN onec_alert_dispatches d USING (dispatch_id)
                     WHERE m.episode_id = e.episode_id AND m.stage IN ('opened', 'digest') ORDER BY d.dispatch_id LIMIT 1)`;
    const effective = `(CASE WHEN p.importance <> 'auto' THEN p.importance WHEN e.severity_max = 'critical' THEN 'critical'
                             WHEN e.severity_max = 'warning' THEN 'important' ELSE 'info' END)`;
    const rank = (expr: string) => `(CASE ${expr} WHEN 'critical' THEN 3 WHEN 'important' THEN 2 ELSE 1 END)`;
    // Group of the kind as in onecAlertGroupOf (kinds missing from the list → 'other').
    const withPolicy = `JOIN onec_alert_notification_policies p ON p.group_code =
        COALESCE((SELECT kg.g FROM unnest($1::text[], $2::text[]) AS kg(kind, g) WHERE kg.kind = e.kind), 'other')`;
    const queries: { where: string; order: string }[] = [
      { where: `e.status = 'pending'`, order: `e.episode_id` },
      { where: `e.status = 'closed_unnotified' AND e.resolved_at IS NULL`, order: `e.episode_id` },
      {
        where: `e.status = 'notified' AND e.resolved_at IS NOT NULL AND e.resolved_at > now() - interval '${RESOLVED_LOOKBACK}'
         AND p.notify_resolved AND ${first} IS NOT NULL AND NOT ${member('resolved')}`,
        order: `e.resolved_at, e.episode_id`,
      },
      {
        where: `e.status = 'notified' AND e.resolved_at IS NULL AND ${first} IS NOT NULL
         AND ((NOT ${member('escalated')} AND ${rank(effective)} > ${rank(first)})
              OR (${effective} = 'critical' AND p.repeat_minutes IS NOT NULL AND e.acknowledged_at IS NULL
                  AND (SELECT count(*) FROM onec_alert_dispatch_members m WHERE m.episode_id = e.episode_id AND m.stage = 'reminder') < ${MAX_REMINDERS}
                  AND ${lastStage} <= now() - make_interval(mins => p.repeat_minutes)))`,
        order: `${lastStage}, e.episode_id`,
      },
    ];
    const kinds = Object.keys(ONEC_ALERT_KINDS);
    const groups = kinds.map((kind) => ONEC_ALERT_KINDS[kind].group);
    const rows: EpisodeCandidate[] = [];
    // The limit is per alert group (R3-1): recipients are a property of the group, so a group nobody can receive
    // never fills the page of another one.
    for (const { where, order } of queries) {
      const result = await client.query<CandidateRow>(
        `SELECT * FROM (
           ${candidatesSql(`row_number() OVER (PARTITION BY p.group_code ORDER BY ${order}) AS group_rank,`)}
           ${withPolicy}
           WHERE ${where}) ranked
          WHERE ranked.group_rank <= ${CANDIDATE_LIMIT_PER_GROUP}
          ORDER BY ranked.group_rank, ranked.episode_id`,
        [kinds, groups],
      );
      rows.push(...result.rows.map(mapCandidate));
    }
    return rows;
  }

  /**
   * Locks the chosen episodes (FOR UPDATE SKIP LOCKED: a writer resolving one of them right now keeps it for the
   * next tick) and re-reads them after the lock, so the stage is decided on committed values.
   */
  async lockCandidates(tx: DatabaseClient, episodeIds: readonly number[]): Promise<EpisodeCandidate[]> {
    if (episodeIds.length === 0) return [];
    const locked = await tx.query<{ episode_id: string }>(
      `SELECT episode_id::text FROM onec_alert_episodes WHERE episode_id = ANY($1::bigint[]) ORDER BY episode_id FOR UPDATE SKIP LOCKED`,
      [episodeIds],
    );
    if (locked.rows.length === 0) return [];
    const { rows } = await tx.query<CandidateRow>(
      `${CANDIDATES_SQL} WHERE e.episode_id = ANY($1::bigint[]) ORDER BY e.episode_id`,
      [locked.rows.map((row) => row.episode_id)],
    );
    return rows.map(mapCandidate);
  }

  /**
   * Recipients of a stage (plan §2.4), under the common permission lock order: permissions_state FOR SHARE → users
   * FOR SHARE. Only active non-service users with an active role and the LITERAL `onec.view` (the bell shows
   * `onec_alert` rows only to them); `configured` — by the policy's roles/users; `manage` — literal `onec.manage`;
   * `superadmin` — literal `system.superadmin`.
   */
  async lockRecipientCandidates(tx: DatabaseClient, policy: Pick<OnecAlertPolicy, 'recipientRoleCodes' | 'recipientUserIds'>): Promise<RecipientCandidate[]> {
    await tx.query(`SELECT 1 FROM permissions_state WHERE id = true FOR SHARE`);
    return this.recipientCandidates(tx, policy, true);
  }

  /** Same set without locks — for the settings screen preview. */
  async previewRecipientCandidates(policy: Pick<OnecAlertPolicy, 'recipientRoleCodes' | 'recipientUserIds'>): Promise<RecipientCandidate[]> {
    return this.recipientCandidates(this.database, policy, false);
  }

  private async recipientCandidates(
    client: DatabaseClient,
    policy: Pick<OnecAlertPolicy, 'recipientRoleCodes' | 'recipientUserIds'>,
    lock: boolean,
  ): Promise<RecipientCandidate[]> {
    const has = (param: string) =>
      `EXISTS (SELECT 1 FROM user_effective_permissions uep WHERE uep.user_id = u.user_id AND uep.permission_name = ${param})`;
    const { rows } = await client.query<{ user_id: string; username: string | null; configured: boolean; manage: boolean; superadmin: boolean }>(
      `SELECT u.user_id::text, u.username,
              (r.role_code = ANY($1::text[]) OR u.user_id = ANY($2::bigint[])) AS configured,
              ${has("'onec.manage'")} AS manage,
              ${has("'system.superadmin'")} AS superadmin
         FROM users u
         JOIN roles r ON r.role_id = u.role_id AND r.is_active = true
        WHERE u.is_active = true AND COALESCE(u.is_service_account, false) = false
          AND ${has("'onec.view'")}
          AND (r.role_code = ANY($1::text[]) OR u.user_id = ANY($2::bigint[]) OR ${has("'onec.manage'")} OR ${has("'system.superadmin'")})
        ORDER BY u.user_id
        ${lock ? 'FOR SHARE OF u' : ''}`,
      [policy.recipientRoleCodes, policy.recipientUserIds],
    );
    return rows.map((row) => ({
      userId: Number(row.user_id),
      username: row.username ?? `#${row.user_id}`,
      configured: row.configured,
      manage: row.manage,
      superadmin: row.superadmin,
    }));
  }

  /** Configured users/roles that are filtered out (inactive, no literal onec.view) — a warning on the settings screen. */
  async filteredOutConfigured(policy: Pick<OnecAlertPolicy, 'recipientRoleCodes' | 'recipientUserIds'>): Promise<{ userId: number; username: string }[]> {
    const { rows } = await this.database.query<{ user_id: string; username: string | null }>(
      `SELECT u.user_id::text, u.username
         FROM users u
         LEFT JOIN roles r ON r.role_id = u.role_id
        WHERE (r.role_code = ANY($1::text[]) OR u.user_id = ANY($2::bigint[]))
          AND COALESCE(u.is_service_account, false) = false
          AND NOT (u.is_active = true AND COALESCE(r.is_active, false) = true
                   AND EXISTS (SELECT 1 FROM user_effective_permissions uep WHERE uep.user_id = u.user_id AND uep.permission_name = 'onec.view'))
        ORDER BY u.user_id
        LIMIT 50`,
      [policy.recipientRoleCodes, policy.recipientUserIds],
    );
    return rows.map((row) => ({ userId: Number(row.user_id), username: row.username ?? `#${row.user_id}` }));
  }

  async insertDispatch(
    tx: DatabaseClient,
    input: { sourceId: number | null; group: OnecAlertGroupCode; stage: OnecAlertStage; importance: OnecAlertImportance; fallbackLevel: number; requestId: string },
  ): Promise<number> {
    const { rows } = await tx.query<{ dispatch_id: string }>(
      `INSERT INTO onec_alert_dispatches (source_id, group_code, stage, importance, fallback_level, request_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING dispatch_id::text`,
      [input.sourceId, input.group, input.stage, input.importance, input.fallbackLevel, input.requestId],
    );
    return Number(rows[0].dispatch_id);
  }

  /** All members in one statement; a member already sent in this stage/seq fails the whole dispatch (unique index). */
  async insertMembers(tx: DatabaseClient, dispatchId: number, stage: OnecAlertStage, members: readonly { episodeId: number; seq: number }[]): Promise<void> {
    await tx.query(
      `INSERT INTO onec_alert_dispatch_members (dispatch_id, episode_id, stage, seq)
       SELECT $1, m.episode_id, $2, m.seq FROM unnest($3::bigint[], $4::smallint[]) AS m(episode_id, seq)`,
      [dispatchId, stage, members.map((m) => m.episodeId), members.map((m) => m.seq)],
    );
  }

  async insertRecipientRows(
    tx: DatabaseClient,
    dispatchId: number,
    rows: readonly { channel: 'in_app' | 'balloon'; userId: number; fallbackLevel: number; notificationId: string }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.query(
      `INSERT INTO onec_alert_dispatch_recipients (dispatch_id, channel, user_id, fallback_level, status, notification_id)
       SELECT $1, r.channel, r.user_id, r.fallback_level, 'written', r.notification_id
         FROM unnest($2::text[], $3::bigint[], $4::smallint[], $5::uuid[]) AS r(channel, user_id, fallback_level, notification_id)`,
      [dispatchId, rows.map((r) => r.channel), rows.map((r) => r.userId), rows.map((r) => r.fallbackLevel), rows.map((r) => r.notificationId)],
    );
  }

  /** Opening and digest mark the episode notified; later stages leave the status as it is. */
  async markNotified(tx: DatabaseClient, episodeIds: readonly number[]): Promise<void> {
    await tx.query(
      `UPDATE onec_alert_episodes SET status = 'notified', updated_at = now() WHERE episode_id = ANY($1::bigint[])`,
      [episodeIds],
    );
  }

  async recentDispatches(limit: number): Promise<RecentDispatchRow[]> {
    const { rows } = await this.database.query<{
      dispatch_id: string;
      group_code: OnecAlertGroupCode;
      stage: OnecAlertStage;
      importance: OnecAlertImportance;
      source_id: string | null;
      fallback_level: number;
      created_at: Date;
      members: number;
      kinds: string[] | null;
      recipients: { userId: number; username: string | null; shown: boolean; read: boolean }[] | null;
    }>(
      `SELECT d.dispatch_id::text, d.group_code, d.stage, d.importance, d.source_id::text, d.fallback_level, d.created_at,
              (SELECT count(*) FROM onec_alert_dispatch_members m WHERE m.dispatch_id = d.dispatch_id)::int AS members,
              (SELECT array_agg(DISTINCT e.kind ORDER BY e.kind) FROM onec_alert_dispatch_members m
                 JOIN onec_alert_episodes e ON e.episode_id = m.episode_id WHERE m.dispatch_id = d.dispatch_id) AS kinds,
              (SELECT json_agg(json_build_object('userId', r.user_id, 'username', u.username,
                                                 'shown', n.balloon_shown_at IS NOT NULL, 'read', COALESCE(n.is_read, false))
                               ORDER BY r.user_id)
                 FROM onec_alert_dispatch_recipients r
                 LEFT JOIN users u ON u.user_id = r.user_id
                 LEFT JOIN notifications n ON n.notification_id = r.notification_id
                WHERE r.dispatch_id = d.dispatch_id AND r.channel = 'in_app') AS recipients
         FROM onec_alert_dispatches d
        ORDER BY d.created_at DESC, d.dispatch_id DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      dispatchId: Number(row.dispatch_id),
      groupCode: row.group_code,
      stage: row.stage,
      importance: row.importance,
      sourceId: row.source_id === null ? null : Number(row.source_id),
      fallbackLevel: Number(row.fallback_level),
      createdAt: new Date(row.created_at).toISOString(),
      members: Number(row.members),
      kinds: row.kinds ?? [],
      recipients: (row.recipients ?? []).map((r) => ({ ...r, userId: Number(r.userId) })),
    }));
  }

  /** Users who may be chosen as recipients on the settings screen: active, non-service, literal onec.view. */
  async recipientOptions(): Promise<{ roles: { code: string; name: string }[]; users: { id: number; name: string }[] }> {
    const roles = await this.database.query<{ role_code: string; role_name: string | null }>(
      `SELECT role_code, COALESCE(role_name, role_code) AS role_name FROM roles WHERE is_active = true ORDER BY role_name, role_code`,
    );
    const users = await this.database.query<{ user_id: string; name: string | null }>(
      `SELECT u.user_id::text, COALESCE(NULLIF(btrim(u.full_name), ''), u.username) AS name
         FROM users u
        WHERE u.is_active = true AND COALESCE(u.is_service_account, false) = false
          AND EXISTS (SELECT 1 FROM user_effective_permissions uep WHERE uep.user_id = u.user_id AND uep.permission_name = 'onec.view')
        ORDER BY name, u.user_id
        LIMIT 500`,
    );
    return {
      roles: roles.rows.map((row) => ({ code: row.role_code, name: row.role_name ?? row.role_code })),
      users: users.rows.map((row) => ({ id: Number(row.user_id), name: row.name ?? `#${row.user_id}` })),
    };
  }
}

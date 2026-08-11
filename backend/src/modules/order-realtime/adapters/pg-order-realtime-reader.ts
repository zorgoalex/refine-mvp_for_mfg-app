import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { mapUserRow } from '../../../permissions/visibility/order-visibility-filter';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import type {
  AuthorizedOrderRealtimeContext,
  OrderDetailLiveState,
  OrderRealtimeReplay,
} from '../application/order-realtime-read.types';
import type { OrderRealtimeCursor, OrderRealtimeDomain, OrderRealtimeEventRecord } from '../application/order-realtime.types';

interface CurrentUserRow extends QueryResultRow {
  user_id: string | number;
  username: string | null;
  role_id: string | number;
  is_active: boolean;
  session_active: boolean;
}

interface OrderScopeRow extends QueryResultRow {
  order_id: string | number;
  created_by: string | number | null;
  manager_id: string | number | null;
}

interface SnapshotRow extends QueryResultRow {
  commit_sequence: string | number;
  detail_status_revision: string | number;
  cut_refs_revision: string | number;
  details: unknown;
}

interface ReplayRow extends QueryResultRow {
  high_watermark: string | number;
  detail_status_revision: string | number;
  cut_refs_revision: string | number;
  earliest_detail_status_revision: string | number | null;
  earliest_cut_refs_revision: string | number | null;
  events: unknown;
}

const orderAccessPolicy = new OrderAccessPolicy();

@Injectable()
export class PgOrderRealtimeReader {
  constructor(private readonly database: DatabaseService) {}

  async authorize(input: {
    tokenUser: CurrentUser;
    orderId: number;
  }): Promise<AuthorizedOrderRealtimeContext> {
    const users = await this.database.query<CurrentUserRow>(
      `
      SELECT u.user_id, u.username, u.role_id, u.is_active,
             CASE
               WHEN $2::text IS NULL THEN true
               ELSE EXISTS (
                 SELECT 1
                 FROM auth_sessions s
                 WHERE s.session_id::text = $2
                   AND s.user_id = u.user_id
                   AND s.status = 'active'
                   AND s.expires_at > now()
               )
             END AS session_active
      FROM users u
      WHERE u.user_id = $1
      `,
      [input.tokenUser.id, input.tokenUser.sessionId ?? null],
    );
    const userRow = users.rows[0];
    const currentUser = userRow ? mapUserRow(userRow) : null;
    if (!userRow?.is_active || !userRow.session_active || !currentUser) {
      throw new ApiError(401, 'AUTH_SESSION_INVALID', 'Authentication session is no longer active');
    }
    currentUser.sessionId = input.tokenUser.sessionId;

    const orders = await this.database.query<OrderScopeRow>(
      `
      SELECT order_id, created_by, manager_id
      FROM orders
      WHERE order_id = $1 AND delete_flag = false
      `,
      [input.orderId],
    );
    const order = orders.rows[0];
    if (
      !order ||
      !orderAccessPolicy.canView(currentUser, {
        orderId: order.order_id,
        createdByUserId: nullableString(order.created_by),
        managerUserId: nullableString(order.manager_id),
        ownerUserId: nullableString(order.manager_id),
      })
    ) {
      throw new ApiError(404, 'ORDER_NOT_FOUND', 'Заказ не найден', { orderId: input.orderId });
    }

    const cutRefsAllowed = currentUser.permissions.includes('cut.view');
    return {
      currentUser,
      cutRefsAllowed,
      permissionVariant: cutRefsAllowed ? 'status_cut' : 'status',
    };
  }

  async loadSnapshot(orderId: number, cutRefsAllowed: boolean): Promise<{
    commitSequence: number;
    detailStatusRevision: number;
    cutRefsRevision: number;
    details: OrderDetailLiveState[];
  }> {
    const result = await this.database.query<SnapshotRow>(
      cutRefsAllowed ? SNAPSHOT_WITH_CUT_SQL : SNAPSHOT_STATUS_SQL,
      [orderId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Заказ не найден', { orderId });

    return {
      commitSequence: toSafeNumber(row.commit_sequence),
      detailStatusRevision: toSafeNumber(row.detail_status_revision),
      cutRefsRevision: toSafeNumber(row.cut_refs_revision),
      details: parseDetails(row.details, cutRefsAllowed),
    };
  }

  async loadReplay(
    orderId: number,
    cursor: OrderRealtimeCursor,
    cutRefsAllowed: boolean,
    maxEvents: number,
  ): Promise<OrderRealtimeReplay> {
    const result = await this.database.query<ReplayRow>(
      cutRefsAllowed ? REPLAY_WITH_CUT_SQL : REPLAY_STATUS_SQL,
      cutRefsAllowed
        ? [orderId, cursor.detailStatusRevision, cursor.cutRefsRevision ?? 0, maxEvents + 1]
        : [orderId, cursor.detailStatusRevision, maxEvents + 1],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Заказ не найден', { orderId });

    const currentCursor: OrderRealtimeCursor = {
      schemaVersion: 1,
      detailStatusRevision: toSafeNumber(row.detail_status_revision),
      ...(cutRefsAllowed ? { cutRefsRevision: toSafeNumber(row.cut_refs_revision) } : {}),
    };
    const cursorFuture =
      cursor.detailStatusRevision > currentCursor.detailStatusRevision ||
      (cutRefsAllowed && (cursor.cutRefsRevision ?? 0) > (currentCursor.cutRefsRevision ?? 0));
    const retentionGap =
      hasDomainGap(
        cursor.detailStatusRevision,
        currentCursor.detailStatusRevision,
        nullableSafeNumber(row.earliest_detail_status_revision),
      ) ||
      (cutRefsAllowed &&
        hasDomainGap(
          cursor.cutRefsRevision ?? 0,
          currentCursor.cutRefsRevision ?? 0,
          nullableSafeNumber(row.earliest_cut_refs_revision),
        ));

    const events = parseEvents(row.events);
    const overflow = events.length > maxEvents;
    return {
      highWatermark: toSafeNumber(row.high_watermark),
      currentCursor,
      events: overflow ? [] : events,
      cursorFuture,
      retentionGap,
      overflow,
    };
  }
}

const SNAPSHOT_STATUS_SQL = `
WITH stream_state AS (
  SELECT o.order_id,
         COALESCE(s.commit_sequence, 0) AS commit_sequence,
         COALESCE(s.detail_status_revision, 0) AS detail_status_revision,
         COALESCE(s.cut_refs_revision, 0) AS cut_refs_revision
  FROM orders o
  LEFT JOIN order_realtime_stream s ON s.order_id = o.order_id
  WHERE o.order_id = $1 AND o.delete_flag = false
),
detail_state AS (
  SELECT d.detail_id, d.production_status_id
  FROM order_details d
  WHERE d.order_id = $1 AND d.delete_flag = false
)
SELECT s.commit_sequence, s.detail_status_revision, s.cut_refs_revision,
       COALESCE(
         jsonb_agg(
           jsonb_build_object(
             'detailId', d.detail_id,
             'productionStatusId', d.production_status_id
           ) ORDER BY d.detail_id
         ) FILTER (WHERE d.detail_id IS NOT NULL),
         '[]'::jsonb
       ) AS details
FROM stream_state s
LEFT JOIN detail_state d ON true
GROUP BY s.commit_sequence, s.detail_status_revision, s.cut_refs_revision
`;

const SNAPSHOT_WITH_CUT_SQL = `
WITH stream_state AS (
  SELECT o.order_id,
         COALESCE(s.commit_sequence, 0) AS commit_sequence,
         COALESCE(s.detail_status_revision, 0) AS detail_status_revision,
         COALESCE(s.cut_refs_revision, 0) AS cut_refs_revision
  FROM orders o
  LEFT JOIN order_realtime_stream s ON s.order_id = o.order_id
  WHERE o.order_id = $1 AND o.delete_flag = false
),
candidates AS (
  SELECT cji.order_detail_id,
         cj.cut_job_id,
         cj.name,
         cr.result_no,
         cj.param_profile_id,
         cpp.name AS profile_name,
         cpp.is_active AS profile_is_active,
         COALESCE(
           cj.last_calc_params->>'layout_mode',
           cpp.params->>'layout_mode',
           cj.params->>'layout_mode'
         ) = 'vacuum_table' AS is_vacuum
  FROM cut_job_item cji
  JOIN cut_job cj ON cj.cut_job_id = cji.cut_job_id
  JOIN cut_result cr
    ON cr.cut_result_id = cj.current_cut_result_id
   AND cr.cut_job_id = cj.cut_job_id
  LEFT JOIN cut_result_archive_state archived
    ON archived.cut_job_id = cr.cut_job_id
   AND archived.result_no = cr.result_no
  LEFT JOIN cut_param_profiles cpp ON cpp.cut_param_profile_id = cj.param_profile_id
  WHERE cji.order_id = $1
    AND cji.is_active = true
    AND cj.status = 'ready'
    AND cj.last_calc_basis IS NOT NULL
    AND archived.cut_job_id IS NULL
),
ranked AS (
  SELECT *, row_number() OVER (
    PARTITION BY order_detail_id, is_vacuum
    ORDER BY cut_job_id DESC
  ) AS rn
  FROM candidates
),
detail_state AS (
  SELECT d.detail_id,
         d.production_status_id,
         regular.cut_job_id AS regular_cut_job_id,
         regular.result_no AS regular_result_no,
         regular.name AS regular_name,
         regular.param_profile_id AS regular_profile_id,
         regular.profile_name AS regular_profile_name,
         regular.profile_is_active AS regular_profile_active,
         bath.cut_job_id AS bath_cut_job_id,
         bath.result_no AS bath_result_no,
         bath.name AS bath_name,
         bath.param_profile_id AS bath_profile_id,
         bath.profile_name AS bath_profile_name,
         bath.profile_is_active AS bath_profile_active
  FROM order_details d
  LEFT JOIN ranked regular
    ON regular.order_detail_id = d.detail_id AND regular.is_vacuum = false AND regular.rn = 1
  LEFT JOIN ranked bath
    ON bath.order_detail_id = d.detail_id AND bath.is_vacuum = true AND bath.rn = 1
  WHERE d.order_id = $1 AND d.delete_flag = false
)
SELECT s.commit_sequence, s.detail_status_revision, s.cut_refs_revision,
       COALESCE(
         jsonb_agg(
           jsonb_build_object(
             'detailId', d.detail_id,
             'productionStatusId', d.production_status_id,
             'cutJob', CASE WHEN d.regular_cut_job_id IS NULL THEN NULL ELSE jsonb_build_object(
               'cutJobId', d.regular_cut_job_id,
               'resultNo', d.regular_result_no,
               'cutNumber', d.regular_cut_job_id::text || '-' || d.regular_result_no::text,
               'name', d.regular_name,
               'paramProfileId', d.regular_profile_id,
               'profileName', d.regular_profile_name,
               'profileIsActive', d.regular_profile_active
             ) END,
             'bathCutJob', CASE WHEN d.bath_cut_job_id IS NULL THEN NULL ELSE jsonb_build_object(
               'cutJobId', d.bath_cut_job_id,
               'resultNo', d.bath_result_no,
               'cutNumber', 'В-' || d.bath_cut_job_id::text || '-' || d.bath_result_no::text,
               'name', d.bath_name,
               'paramProfileId', d.bath_profile_id,
               'profileName', d.bath_profile_name,
               'profileIsActive', d.bath_profile_active
             ) END
           ) ORDER BY d.detail_id
         ) FILTER (WHERE d.detail_id IS NOT NULL),
         '[]'::jsonb
       ) AS details
FROM stream_state s
LEFT JOIN detail_state d ON true
GROUP BY s.commit_sequence, s.detail_status_revision, s.cut_refs_revision
`;

const REPLAY_STATUS_SQL = `
WITH stream_state AS (
  SELECT o.order_id,
         COALESCE(s.commit_sequence, 0) AS commit_sequence,
         COALESCE(s.detail_status_revision, 0) AS detail_status_revision,
         COALESCE(s.cut_refs_revision, 0) AS cut_refs_revision
  FROM orders o
  LEFT JOIN order_realtime_stream s ON s.order_id = o.order_id
  WHERE o.order_id = $1 AND o.delete_flag = false
),
candidates AS (
  SELECT e.*
  FROM realtime_event_log e
  CROSS JOIN stream_state s
  WHERE e.order_id = $1
    AND e.detail_status_revision > $2
    AND e.commit_sequence <= s.commit_sequence
  ORDER BY e.commit_sequence
  LIMIT $3
)
SELECT s.commit_sequence AS high_watermark,
       s.detail_status_revision,
       s.cut_refs_revision,
       (SELECT min(detail_status_revision) FROM realtime_event_log
        WHERE order_id = $1 AND detail_status_revision IS NOT NULL) AS earliest_detail_status_revision,
       NULL::bigint AS earliest_cut_refs_revision,
       COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.commit_sequence)
         FILTER (WHERE c.commit_sequence IS NOT NULL), '[]'::jsonb) AS events
FROM stream_state s
LEFT JOIN candidates c ON true
GROUP BY s.commit_sequence, s.detail_status_revision, s.cut_refs_revision
`;

const REPLAY_WITH_CUT_SQL = `
WITH stream_state AS (
  SELECT o.order_id,
         COALESCE(s.commit_sequence, 0) AS commit_sequence,
         COALESCE(s.detail_status_revision, 0) AS detail_status_revision,
         COALESCE(s.cut_refs_revision, 0) AS cut_refs_revision
  FROM orders o
  LEFT JOIN order_realtime_stream s ON s.order_id = o.order_id
  WHERE o.order_id = $1 AND o.delete_flag = false
),
candidate_sequences AS (
  SELECT e.commit_sequence
  FROM realtime_event_log e
  CROSS JOIN stream_state s
  WHERE e.order_id = $1
    AND e.detail_status_revision > $2
    AND e.commit_sequence <= s.commit_sequence
  UNION
  SELECT e.commit_sequence
  FROM realtime_event_log e
  CROSS JOIN stream_state s
  WHERE e.order_id = $1
    AND e.cut_refs_revision > $3
    AND e.commit_sequence <= s.commit_sequence
),
candidates AS (
  SELECT e.*
  FROM candidate_sequences candidate
  JOIN realtime_event_log e
    ON e.order_id = $1 AND e.commit_sequence = candidate.commit_sequence
  ORDER BY e.commit_sequence
  LIMIT $4
)
SELECT s.commit_sequence AS high_watermark,
       s.detail_status_revision,
       s.cut_refs_revision,
       (SELECT min(detail_status_revision) FROM realtime_event_log
        WHERE order_id = $1 AND detail_status_revision IS NOT NULL) AS earliest_detail_status_revision,
       (SELECT min(cut_refs_revision) FROM realtime_event_log
        WHERE order_id = $1 AND cut_refs_revision IS NOT NULL) AS earliest_cut_refs_revision,
       COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.commit_sequence)
         FILTER (WHERE c.commit_sequence IS NOT NULL), '[]'::jsonb) AS events
FROM stream_state s
LEFT JOIN candidates c ON true
GROUP BY s.commit_sequence, s.detail_status_revision, s.cut_refs_revision
`;

function parseDetails(value: unknown, cutRefsAllowed: boolean): OrderDetailLiveState[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const row = entry as Record<string, unknown>;
    return {
      detailId: toSafeNumber(row.detailId),
      productionStatusId: row.productionStatusId === null ? null : toSafeNumber(row.productionStatusId),
      ...(cutRefsAllowed
        ? {
            cutJob: parseCutRef(row.cutJob),
            bathCutJob: parseCutRef(row.bathCutJob),
          }
        : {}),
    };
  });
}

function parseCutRef(value: unknown) {
  if (value === null || value === undefined) return null;
  const row = value as Record<string, unknown>;
  return {
    cutJobId: toSafeNumber(row.cutJobId),
    resultNo: toSafeNumber(row.resultNo),
    cutNumber: String(row.cutNumber),
    name: String(row.name),
    paramProfileId: row.paramProfileId === null ? null : toSafeNumber(row.paramProfileId),
    profileName: row.profileName === null ? null : String(row.profileName),
    profileIsActive: row.profileIsActive === null ? null : Boolean(row.profileIsActive),
  };
}

function parseEvents(value: unknown): OrderRealtimeEventRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const row = entry as Record<string, unknown>;
    return {
      orderId: toSafeNumber(row.order_id),
      commitSequence: toSafeNumber(row.commit_sequence),
      detailStatusRevision:
        row.detail_status_revision === null ? null : toSafeNumber(row.detail_status_revision),
      cutRefsRevision: row.cut_refs_revision === null ? null : toSafeNumber(row.cut_refs_revision),
      domains: (Array.isArray(row.domains) ? row.domains : []) as OrderRealtimeDomain[],
      detailIds: Array.isArray(row.detail_ids) ? row.detail_ids.map(toSafeNumber) : null,
      occurredAt: new Date(String(row.occurred_at)).toISOString(),
    };
  });
}

function hasDomainGap(cursor: number, current: number, earliest: number | null): boolean {
  if (current <= cursor) return false;
  return earliest === null || earliest > cursor + 1;
}

function nullableSafeNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : toSafeNumber(value);
}

function toSafeNumber(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid realtime numeric value');
  return parsed;
}

function nullableString(value: string | number | null): string | null {
  return value === null ? null : String(value);
}

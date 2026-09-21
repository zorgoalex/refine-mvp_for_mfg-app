import type { DatabaseClient } from '../../../database/database.types';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import type { MdfJobDatabase } from '../application/mdf-job-runner';
import { mdfSourceCommandToken } from '../domain/mdf-manual-proof';

export interface MdfPublishedQuery {
  dateTo?: string;
  focus?: { kind: 'packet'|'bazisCutSet'|'bath'; id: string };
  /** Current order cards selected by the caller. Visibility only; quantities
   * still come from the complete accepted ledger, never the visible files. */
  orderIds?: readonly number[];
}
export interface PublishedCard {
  kind: 'packet'|'bazisCutSet'|'bath'; id: string; displayName: string; column: string|null;
  sourceCreatedAt: string; acceptedRevision: string|null; receivedRevision: string; issues: string[];
  commandToken?: string|null;
}
export interface PublishedPosition {
  orderId: number; detailId: number; required: number; cut: number; rolled: number;
  creditedCut: number; creditedRolled: number; remaining: number; issues: string[];
}
export interface PublishedMember { kind: string; id: string; orderId: number; detailId: number; quantity: number }

/** One read-only MVCC snapshot. This adapter cannot intake, allocate or run a
 * rule. Caller must check orders.view BEFORE invoking it (and before HTTP304).
 * Scope is resolved from current server policy, never client-supplied owner ids.
 * The two-month window limits cards only; position totals are already accounted
 * against all accepted history. No legacy/source JSON readiness fallback. */
export async function readMdfPublishedSnapshot(database: MdfJobDatabase, user: CurrentUser, query: MdfPublishedQuery = {}) {
  return database.transaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const state = (await tx.query<{ mode: string; revision: string; generatedAt: string; dateFrom: string; dateTo: string }>(`SELECT
      mode,published_revision::text revision,transaction_timestamp()::text "generatedAt",
      (COALESCE($1::date,current_date)-interval '2 months')::date::text "dateFrom",
      COALESCE($1::date,current_date)::text "dateTo" FROM mdf_engine_state WHERE singleton`,[query.dateTo ?? null])).rows[0];
    if (!state) throw new ApiError(503,'MDF_STATE_UNAVAILABLE','Состояние МДФ-доски недоступно');
    if (state.mode!=='active' && state.mode!=='read_only') return { schemaVersion: 1 as const, ...state,
      cards: [],positions: [],members: [],pendingJobs: [],issues: ['MDF_PUBLICATION_NOT_ACTIVE'] };
    const scope = rolePolicyForUser(user).orders.view;
    const allowed = scope==='all' ? 'TRUE' : scope==='own' ? '(o.created_by=$1::bigint OR o.manager_id=$1::bigint)'
      : scope==='assigned' ? `EXISTS(SELECT 1 FROM order_workshops w JOIN users u
        ON u.employee_id=w.responsible_employee_id WHERE w.order_id=o.order_id AND NOT w.delete_flag
        AND u.is_active AND u.user_id=$1::bigint)` : 'FALSE';
    const owners = `SELECT o.order_id FROM orders o WHERE $1::bigint IS NOT NULL
      AND NOT o.delete_flag AND o.order_kind='production_order' AND ${allowed}`;
    const cardRows = (await tx.query<PublishedCard & { headVersion: string; headEpoch: string; headReceived: string; headAccepted: string|null }>(`WITH allowed AS (${owners})
      SELECT p.source_kind kind,p.source_id id,p.display_name "displayName",p.column_key "column",
        p.source_created_at::text "sourceCreatedAt",p.accepted_revision_key "acceptedRevision",
        p.received_revision_key "receivedRevision",p.issues,h.version::text "headVersion",h.correction_epoch::text "headEpoch",
        h.received_revision_key "headReceived",h.accepted_revision_key "headAccepted"
      FROM mdf_published_sources p
      JOIN mdf_source_heads h ON h.source_kind=p.source_kind AND h.source_id=p.source_id
      WHERE ((p.source_created_at >= $2::date AND p.source_created_at < $3::date+interval '1 day')
        OR (p.source_kind=$4 AND p.source_id=$5))
        AND NOT EXISTS(SELECT 1 FROM mdf_published_source_members m WHERE m.source_kind=p.source_kind AND m.source_id=p.source_id
          AND NOT EXISTS(SELECT 1 FROM allowed a WHERE a.order_id=m.order_id))
        AND ($6::boolean OR EXISTS(SELECT 1 FROM mdf_published_source_members m
          WHERE m.source_kind=p.source_kind AND m.source_id=p.source_id))
      ORDER BY p.source_created_at DESC,p.source_kind,p.source_id LIMIT 1001`,
    [user.id,state.dateFrom,state.dateTo,query.focus?.kind ?? null,query.focus?.id ?? null,scope==='all'])).rows;
    checkLimit(cardRows,1000);
    const cards: PublishedCard[] = cardRows.map(({ headVersion,headEpoch,headReceived,headAccepted,...card }) => ({ ...card,
      commandToken: headReceived === card.receivedRevision && headAccepted === headReceived && card.issues.length === 0
        ? mdfSourceCommandToken(card,{ received: headReceived,version: headVersion,epoch: headEpoch }) : null }));
    const members = (await tx.query<PublishedMember>(`SELECT m.source_kind kind,m.source_id id,m.order_id::float8 "orderId",
      m.detail_id::float8 "detailId",m.quantity::float8 quantity FROM mdf_published_source_members m
      JOIN unnest($1::text[],$2::text[]) s(kind,id) ON m.source_kind=s.kind AND m.source_id=s.id
      ORDER BY m.source_kind,m.source_id,m.order_id,m.detail_id LIMIT 10001`,[cards.map(c => c.kind),cards.map(c => c.id)])).rows;
    checkLimit(members,10000);
    const pendingJobs = await loadPending(tx,owners,user.id,state,query,scope==='all');
    const selectedOwners = [...new Set([...members.map(m => m.orderId),...(query.orderIds ?? []),
      ...pendingJobs.flatMap(j => j.orderIds)])];
    const positions = (await tx.query<PublishedPosition>(`WITH allowed AS (${owners})
      SELECT p.order_id::float8 "orderId",p.detail_id::float8 "detailId",p.required_quantity::float8 required,
        p.cut_quantity::float8 cut,p.rolled_quantity::float8 rolled,p.credited_cut::float8 "creditedCut",
        p.credited_rolled::float8 "creditedRolled",p.remaining::float8 remaining,p.issues
      FROM mdf_published_positions p JOIN allowed a USING(order_id)
      WHERE p.order_id=ANY($2::bigint[]) ORDER BY p.order_id,p.detail_id LIMIT 10001`,
    [user.id,selectedOwners])).rows;
    checkLimit(positions,10000);
    return { schemaVersion: 1 as const, ...state, cards,positions,members,pendingJobs,
      issues: state.mode==='read_only' ? ['MDF_READ_ONLY'] : [] };
  });
}

async function loadPending(tx: DatabaseClient,owners: string,userId: string,
  state: { dateFrom: string; dateTo: string },query: MdfPublishedQuery,allowUnlinked: boolean) {
  const rows = (await tx.query<{ jobId: string; kind: string; id: string; status: string; code: string|null;
    attempts: number; orderIds: number[] }>(`WITH allowed AS (${owners}) SELECT
    j.job_id "jobId",j.source_kind kind,j.source_id id,j.status,j.error_code code,j.attempts,
    ARRAY(SELECT DISTINCT e.order_id::float8 FROM mdf_evidence_lines e WHERE e.source_kind=j.source_kind
      AND e.source_id=j.source_id AND e.revision_key=j.revision_key ORDER BY e.order_id::float8) "orderIds"
    FROM mdf_recalculation_jobs j
    JOIN mdf_source_heads h ON h.source_kind=j.source_kind AND h.source_id=j.source_id
      AND h.received_revision_key=j.revision_key AND h.correction_epoch=j.correction_epoch
    LEFT JOIN mdf_revision_context c ON c.source_kind=j.source_kind AND c.source_id=j.source_id AND c.revision_key=j.revision_key
    WHERE j.status IN ('pending','needs_attention')
      AND ((COALESCE(c.source_created_at,j.created_at) >= $2::date
        AND COALESCE(c.source_created_at,j.created_at) < $3::date+interval '1 day')
        OR (j.source_kind=$4 AND j.source_id=$5)
        OR EXISTS(SELECT 1 FROM mdf_evidence_lines e WHERE e.source_kind=j.source_kind AND e.source_id=j.source_id
          AND e.revision_key=j.revision_key AND e.order_id=ANY($6::bigint[])))
      AND ($7::boolean OR EXISTS(SELECT 1 FROM mdf_evidence_lines e JOIN allowed a USING(order_id)
        WHERE e.source_kind=j.source_kind AND e.source_id=j.source_id AND e.revision_key=j.revision_key))
      AND NOT EXISTS(SELECT 1 FROM mdf_evidence_lines e WHERE e.source_kind=j.source_kind AND e.source_id=j.source_id
        AND e.revision_key=j.revision_key AND NOT EXISTS(SELECT 1 FROM allowed a WHERE a.order_id=e.order_id))
    ORDER BY j.created_at,j.job_id LIMIT 1001`,
  [userId,state.dateFrom,state.dateTo,query.focus?.kind ?? null,query.focus?.id ?? null,query.orderIds ?? [],allowUnlinked])).rows;
  checkLimit(rows,1000); return rows;
}
function checkLimit(rows: readonly unknown[],limit: number): void {
  if (rows.length>limit) throw new ApiError(422,'MDF_PUBLICATION_SCOPE_LIMIT','Слишком большой состав доски. Уточните период.');
}

import type { DatabaseClient } from '../../../database/database.types';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import type { MdfJobDatabase } from '../application/mdf-job-runner';
import { mdfSourceCommandToken } from '../domain/mdf-manual-proof';
import { loadMdfEffectivePlacement } from './mdf-effective-placement';
import { mdfSourceKey } from './mdf-execution-snapshot';

export interface MdfPublishedQuery {
  dateTo?: string;
  focus?: { kind: 'packet'|'bazisCutSet'|'bath'; id: string };
  /** Current order cards selected by the caller. Visibility only; quantities
   * still come from the complete accepted ledger, never the visible files. */
  orderIds?: readonly number[];
  /** Exact command jobs, independent of card period and current source head. */
  jobIds?: readonly string[];
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
      cards: [],positions: [],members: [],pendingJobs: [],trackedJobs: [],issues: ['MDF_PUBLICATION_NOT_ACTIVE'] };
    const scope = rolePolicyForUser(user).orders.view;
    const owners = mdfAllowedOrdersSql(user);
    // Card owners = current published members ∪ demand/evidence owners of the exact
    // published accepted AND received revisions (retained physical proof survives a
    // composition edit). Never today's head, never caller-provided owners or markers.
    const cardOwners = mdfPublishedCardOwnersSql;
    // Visibility (at least one allowed owner) is decided BEFORE the page limit, so newer
    // denied cards can never push an older authorized/focused card out of the page.
    const cardRows = (await tx.query<PublishedCard & { headVersion: string; headEpoch: string; headReceived: string;
      headAccepted: string|null; ownerIds: number[]; allOwnersAllowed: boolean }>(`WITH allowed AS (${owners}), page AS (
      SELECT p.source_kind,p.source_id,p.display_name,p.column_key,p.source_created_at,p.accepted_revision_key,
        p.received_revision_key,p.issues,h.version,h.correction_epoch,h.received_revision_key head_received,
        h.accepted_revision_key head_accepted
      FROM mdf_published_sources p
      JOIN mdf_source_heads h ON h.source_kind=p.source_kind AND h.source_id=p.source_id
      WHERE ((p.source_created_at >= $2::date AND p.source_created_at < $3::date+interval '1 day')
        OR (p.source_kind=$4 AND p.source_id=$5))
        AND ($6::boolean OR EXISTS(SELECT 1 FROM allowed a WHERE a.order_id IN (${cardOwners('p')})))
      ORDER BY p.source_created_at DESC,p.source_kind,p.source_id LIMIT 1001)
      SELECT page.source_kind kind,page.source_id id,page.display_name "displayName",page.column_key "column",
        page.source_created_at::text "sourceCreatedAt",page.accepted_revision_key "acceptedRevision",
        page.received_revision_key "receivedRevision",page.issues,page.version::text "headVersion",
        page.correction_epoch::text "headEpoch",page.head_received "headReceived",page.head_accepted "headAccepted",
        o.owner_ids "ownerIds",o.all_allowed "allOwnersAllowed"
      FROM page CROSS JOIN LATERAL (
        SELECT COALESCE(array_agg(x.order_id::float8 ORDER BY x.order_id),'{}') owner_ids,
          COALESCE(bool_and(EXISTS(SELECT 1 FROM allowed a WHERE a.order_id=x.order_id)),$6::boolean) all_allowed
        FROM (${cardOwners('page')}) x(order_id)) o
      ORDER BY page.source_created_at DESC,page.source_kind,page.source_id`,
    [user.id,state.dateFrom,state.dateTo,query.focus?.kind ?? null,query.focus?.id ?? null,scope==='all'])).rows;
    checkLimit(cardRows,1000);
    const cardOwnerIds = cardRows.flatMap(c => c.ownerIds);
    // §5.4d: placement follows the members' live ranks (one set-based read, no writes/automation).
    // Unusable inputs keep the stored column and make the card non-movable.
    const placements = await loadMdfEffectivePlacement(tx, cardRows);
    for (const card of cardRows) {
      const placement = placements.get(mdfSourceKey(card));
      if (!placement) continue;
      card.column = placement.column;
      // Live placement issues (missing inputs, missing stage thresholds, …) block the command token.
      if (placement.issues.length) card.issues = [...new Set([...card.issues, ...placement.issues])];
    }
    // A partial viewer sees the card but only its allowed orders' data, and never a
    // command token: a command would act on positions of orders it cannot see.
    const cards: PublishedCard[] = cardRows.map(({ headVersion,headEpoch,headReceived,headAccepted,ownerIds: _ownerIds,
      allOwnersAllowed,...card }) => ({ ...card,
      issues: allOwnersAllowed ? card.issues : [...card.issues,'MDF_PARTIAL_ACCESS'],
      commandToken: allOwnersAllowed && headReceived === card.receivedRevision && headAccepted === headReceived
        && card.issues.length === 0
        ? mdfSourceCommandToken(card,{ received: headReceived,version: headVersion,epoch: headEpoch }) : null }));
    const members = (await tx.query<PublishedMember>(`WITH allowed AS (${owners})
      SELECT m.source_kind kind,m.source_id id,m.order_id::float8 "orderId",
      m.detail_id::float8 "detailId",m.quantity::float8 quantity FROM mdf_published_source_members m
      JOIN unnest($2::text[],$3::text[]) s(kind,id) ON m.source_kind=s.kind AND m.source_id=s.id
      JOIN allowed a ON a.order_id=m.order_id
      ORDER BY m.source_kind,m.source_id,m.order_id,m.detail_id LIMIT 10001`,
    [user.id,cards.map(c => c.kind),cards.map(c => c.id)])).rows;
    checkLimit(members,10000);
    const pendingJobs = await loadPending(tx,owners,user.id,state,query,scope==='all');
    const trackedJobs = await loadTracked(tx,owners,user.id,query.jobIds ?? [],scope==='all');
    const selectedOwners = [...new Set([...members.map(m => m.orderId),...cardOwnerIds,...(query.orderIds ?? []),
      ...pendingJobs.flatMap(j => j.orderIds)])];
    const positions = (await tx.query<PublishedPosition>(`WITH allowed AS (${owners})
      SELECT p.order_id::float8 "orderId",p.detail_id::float8 "detailId",p.required_quantity::float8 required,
        p.cut_quantity::float8 cut,p.rolled_quantity::float8 rolled,p.credited_cut::float8 "creditedCut",
        p.credited_rolled::float8 "creditedRolled",p.remaining::float8 remaining,p.issues
      FROM mdf_published_positions p JOIN allowed a USING(order_id)
      WHERE p.order_id=ANY($2::bigint[]) ORDER BY p.order_id,p.detail_id LIMIT 10001`,
    [user.id,selectedOwners])).rows;
    checkLimit(positions,10000);
    return { schemaVersion: 1 as const, ...state, cards,positions,members,pendingJobs,trackedJobs,
      issues: state.mode==='read_only' ? ['MDF_READ_ONLY'] : [] };
  });
}

/** Orders the user may view under the current server scope ($1 = user id). */
export function mdfAllowedOrdersSql(user: CurrentUser): string {
  const scope = rolePolicyForUser(user).orders.view;
  const allowed = scope==='all' ? 'TRUE' : scope==='own' ? '(o.created_by=$1::bigint OR o.manager_id=$1::bigint)'
    : scope==='assigned' ? `EXISTS(SELECT 1 FROM order_workshops w JOIN users u
      ON u.employee_id=w.responsible_employee_id WHERE w.order_id=o.order_id AND NOT w.delete_flag
      AND u.is_active AND u.user_id=$1::bigint)` : 'FALSE';
  return `SELECT o.order_id FROM orders o WHERE $1::bigint IS NOT NULL
    AND NOT o.delete_flag AND o.order_kind='production_order' AND ${allowed}`;
}

/** Card owners = current published members ∪ demand/evidence owners of the exact published
 * accepted AND received revisions of the `mdf_published_sources` row aliased as `alias`. */
export function mdfPublishedCardOwnersSql(alias: string): string {
  return `SELECT m.order_id FROM mdf_published_source_members m
        WHERE m.source_kind=${alias}.source_kind AND m.source_id=${alias}.source_id
      UNION SELECT d.order_id FROM mdf_revision_demand d
        WHERE d.source_kind=${alias}.source_kind AND d.source_id=${alias}.source_id
          AND d.revision_key IN (${alias}.accepted_revision_key,${alias}.received_revision_key)
      UNION SELECT e.order_id FROM mdf_evidence_lines e
        WHERE e.source_kind=${alias}.source_kind AND e.source_id=${alias}.source_id
          AND e.revision_key IN (${alias}.accepted_revision_key,${alias}.received_revision_key)`;
}

async function loadTracked(tx: DatabaseClient,owners: string,userId: string,jobIds: readonly string[],allowUnlinked: boolean) {
  if (!jobIds.length) return [];
  // Demand also includes owners removed from current membership. Never authorize
  // an old receipt through just the current card, its actor, or caller orderIds.
  return (await tx.query<{ jobId: string; kind: string; id: string; status: string; code: string|null;
    attempts: number; orderIds: number[] }>(`WITH allowed AS (${owners}), requested AS (
      SELECT * FROM mdf_recalculation_jobs WHERE job_id=ANY($2::uuid[])
    ), frozen_owners AS (
      SELECT j.job_id,d.order_id FROM requested j JOIN mdf_revision_demand d
        ON d.source_kind=j.source_kind AND d.source_id=j.source_id AND d.revision_key=j.revision_key
      UNION
      SELECT j.job_id,e.order_id FROM requested j JOIN mdf_evidence_lines e
        ON e.source_kind=j.source_kind AND e.source_id=j.source_id AND e.revision_key=j.revision_key
    ) SELECT j.job_id "jobId",j.source_kind kind,j.source_id id,j.status,j.error_code code,j.attempts,
      ARRAY(SELECT f.order_id::float8 FROM frozen_owners f WHERE f.job_id=j.job_id ORDER BY f.order_id) "orderIds"
    FROM requested j
    WHERE NOT EXISTS(SELECT 1 FROM frozen_owners f WHERE f.job_id=j.job_id
      AND NOT EXISTS(SELECT 1 FROM allowed a WHERE a.order_id=f.order_id))
      AND ($3::boolean OR EXISTS(SELECT 1 FROM frozen_owners f WHERE f.job_id=j.job_id))
    ORDER BY j.job_id`,[userId,jobIds,allowUnlinked])).rows;
}

async function loadPending(tx: DatabaseClient,owners: string,userId: string,
  state: { dateFrom: string; dateTo: string },query: MdfPublishedQuery,allowUnlinked: boolean) {
  const rows = (await tx.query<{ jobId: string; kind: string; id: string; status: string; code: string|null;
    attempts: number; orderIds: number[] }>(`WITH allowed AS (${owners}), current_jobs AS (
    SELECT j.* FROM mdf_recalculation_jobs j
    JOIN mdf_source_heads h ON h.source_kind=j.source_kind AND h.source_id=j.source_id
      AND h.received_revision_key=j.revision_key AND h.correction_epoch=j.correction_epoch
    LEFT JOIN mdf_revision_context c ON c.source_kind=j.source_kind AND c.source_id=j.source_id AND c.revision_key=j.revision_key
    WHERE j.status IN ('pending','needs_attention')
      AND ((COALESCE(c.source_created_at,j.created_at) >= $2::date
        AND COALESCE(c.source_created_at,j.created_at) < $3::date+interval '1 day')
        OR (j.source_kind=$4 AND j.source_id=$5)
        OR EXISTS(SELECT 1 FROM mdf_evidence_lines e WHERE e.source_kind=j.source_kind AND e.source_id=j.source_id
          AND e.revision_key=j.revision_key AND e.order_id=ANY($6::bigint[]))
        OR EXISTS(SELECT 1 FROM mdf_revision_demand d WHERE d.source_kind=j.source_kind AND d.source_id=j.source_id
          AND d.revision_key=j.revision_key AND d.order_id=ANY($6::bigint[])))
    ), frozen_owners AS (
      SELECT j.job_id,d.order_id FROM current_jobs j JOIN mdf_revision_demand d
        ON d.source_kind=j.source_kind AND d.source_id=j.source_id AND d.revision_key=j.revision_key
      UNION
      SELECT j.job_id,e.order_id FROM current_jobs j JOIN mdf_evidence_lines e
        ON e.source_kind=j.source_kind AND e.source_id=j.source_id AND e.revision_key=j.revision_key
    ) SELECT
    j.job_id "jobId",j.source_kind kind,j.source_id id,j.status,j.error_code code,j.attempts,
    ARRAY(SELECT f.order_id::float8 FROM frozen_owners f WHERE f.job_id=j.job_id ORDER BY f.order_id) "orderIds"
    FROM current_jobs j
    WHERE ($7::boolean OR EXISTS(SELECT 1 FROM frozen_owners f WHERE f.job_id=j.job_id))
      AND NOT EXISTS(SELECT 1 FROM frozen_owners f WHERE f.job_id=j.job_id
        AND NOT EXISTS(SELECT 1 FROM allowed a WHERE a.order_id=f.order_id))
    ORDER BY j.created_at,j.job_id LIMIT 1001`,
  [userId,state.dateFrom,state.dateTo,query.focus?.kind ?? null,query.focus?.id ?? null,query.orderIds ?? [],allowUnlinked])).rows;
  checkLimit(rows,1000); return rows;
}
function checkLimit(rows: readonly unknown[],limit: number): void {
  if (rows.length>limit) throw new ApiError(422,'MDF_PUBLICATION_SCOPE_LIMIT','Слишком большой состав доски. Уточните период.');
}

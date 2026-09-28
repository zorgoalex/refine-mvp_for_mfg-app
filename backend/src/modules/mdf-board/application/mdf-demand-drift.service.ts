import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionsService } from '../../../permissions/permissions.service';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import { rolePolicyForUser } from '../../../permissions/policies/scope';
import { findMdfDemandDrift, loadMdfSourceOwnerGraph, MDF_CONFLICT_LOCK_ORDER, mdfReconcileCommandKey, partitionMdfDrift }
  from '../adapters/mdf-demand-reconciler';
import { reconcileMdfOrderDemand } from '../adapters/mdf-order-cascade';
import { mdfAllowedOrdersSql } from '../adapters/mdf-published-snapshot';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface MdfDemandDriftConflictDto {
  conflictId: string; sourceKind: string; sourceId: string; code: string; orderIds: number[]; detectedAt: string;
}

/** §5.8 demand-drift conflicts: list (orders.view, every owner visible) and resolve through the SAME confirmed
 * order cascade as an order save (literal `orders.update`, every owner in scope, preview digest ⇒ confirm). */
export class MdfDemandDriftService {
  private readonly orderPolicy = new OrderAccessPolicy();
  constructor(private readonly database: DatabaseService, private readonly permissions: PermissionsService) {}

  async list(user: CurrentUser): Promise<MdfDemandDriftConflictDto[]> {
    if (!this.permissions.canUser(user, 'orders.view')) throw denied(['orders.view']);
    const allowed = mdfAllowedOrdersSql(user);
    return (await this.database.query<MdfDemandDriftConflictDto>(`WITH allowed AS (${allowed})
      SELECT c.conflict_id::text "conflictId",c.source_kind "sourceKind",c.source_id "sourceId",c.code,
        ARRAY(SELECT o::float8 FROM unnest(c.owner_ids) o) "orderIds",c.detected_at::text "detectedAt"
      FROM mdf_demand_drift_conflicts c
      WHERE c.status='open' AND ($2::boolean OR NOT EXISTS(SELECT 1 FROM unnest(c.owner_ids) o
        WHERE o NOT IN (SELECT order_id FROM allowed)))
      ORDER BY c.detected_at LIMIT 500`, [user.id, rolePolicyForUser(user).orders.view === 'all'])).rows;
  }

  async confirm(user: CurrentUser, conflictId: string, digest: string | null, requestId: string): Promise<{ resolved: number }> {
    if (!this.permissions.canUser(user, 'orders.update')) throw denied(['orders.update']);
    if (!UUID_RE.test(conflictId) || (digest !== null && !/^[a-f0-9]{64}$/.test(digest))) {
      throw new ApiError(400, 'MDF_DRIFT_INVALID', 'Некорректный запрос');
    }
    return this.database.transaction(async tx => {
      // No conflict-row lock here: locks are taken in the global order orders → sources (inside the cascade) →
      // conflict rows (MDF_CONFLICT_LOCK_ORDER), then the selected row is revalidated.
      const conflict = (await tx.query<{ source_kind: string; source_id: string; owner_ids: string[]; status: string }>(
        `SELECT source_kind,source_id,owner_ids::text[] owner_ids,status FROM mdf_demand_drift_conflicts
         WHERE conflict_id=$1::uuid`, [conflictId])).rows[0];
      if (!conflict) throw new ApiError(404, 'MDF_DRIFT_NOT_FOUND', 'Расхождение не найдено');
      if (conflict.status !== 'open') throw alreadyResolved();
      // The current closure is recomputed under the command boundary; the stored row only names the source.
      const group = partitionMdfDrift(await findMdfDemandDrift(tx), await loadMdfSourceOwnerGraph(tx))
        .find(g => g.some(s => s.kind === conflict.source_kind && s.id === conflict.source_id));
      const orderIds = [...new Set([...(group ?? []).flatMap(s => s.owners), ...conflict.owner_ids.map(Number)])].sort((a, b) => a - b);
      // Write authority: literal orders.update scope + visibility on EVERY affected owner, read under the owners' row
      // locks (ascending, the order-command lock order). Checked up front for the estimated set, and again by the cascade
      // for the FINAL locked affected-source set (discovery may have grown meanwhile) before anything is written.
      const authorize = async (ids: readonly number[]) => {
        const owners = (await tx.query<{ order_id: string; created_by: string | null; manager_id: string | null }>(
          `SELECT order_id::text,created_by::text,manager_id::text FROM orders WHERE order_id=ANY($1::bigint[])
           ORDER BY order_id FOR UPDATE`, [ids])).rows;
        if (owners.length !== new Set(ids).size || owners.some(o => !this.orderPolicy.canUpdate(user, {
          orderId: o.order_id, createdByUserId: o.created_by, managerUserId: o.manager_id }))) throw denied(['orders.update']);
        const visible = (await tx.query<{ n: string }>(`WITH allowed AS (${mdfAllowedOrdersSql(user)})
          SELECT count(DISTINCT o)::text n FROM unnest($2::bigint[]) o WHERE o IN (SELECT order_id FROM allowed)`,
        [user.id, ids])).rows[0].n;
        if (rolePolicyForUser(user).orders.view !== 'all' && Number(visible) !== new Set(ids).size) throw denied(['orders.update']);
      };
      await authorize(orderIds);
      if (group) {
        await reconcileMdfOrderDemand(tx, { user, requestId, commandKey: `${mdfReconcileCommandKey(group)}:confirm`,
          orderIds: [...new Set(group.flatMap(s => s.owners))].sort((a, b) => a - b), confirmation: digest ? { digest } : null,
          authorizeOwners: authorize });
      }
      const keys = (group ?? [{ kind: conflict.source_kind, id: conflict.source_id }]).map(s => [s.kind, s.id]);
      const locked = (await tx.query<{ conflict_id: string; status: string }>(`SELECT c.conflict_id::text,c.status
        FROM mdf_demand_drift_conflicts c JOIN unnest($1::text[],$2::text[]) k(kind,id) ON c.source_kind=k.kind AND c.source_id=k.id
        WHERE c.status='open' OR c.conflict_id=$3::uuid ORDER BY ${MDF_CONFLICT_LOCK_ORDER.split(',').map(c => `c.${c}`).join(',')}
        FOR UPDATE OF c`, [keys.map(k => k[0]), keys.map(k => k[1]), conflictId])).rows;
      // A concurrent confirmation (or the reconciler) resolved it meanwhile: the whole command rolls back.
      if (locked.find(r => r.conflict_id === conflictId)?.status !== 'open') throw alreadyResolved();
      const resolved = (await tx.query<{ conflict_id: string }>(`UPDATE mdf_demand_drift_conflicts
        SET status='resolved',resolved_at=now(),resolved_request_id=$2,resolved_by_user_id=$3::bigint
        WHERE conflict_id=ANY($1::uuid[]) AND status='open' RETURNING conflict_id::text`,
      [locked.filter(r => r.status === 'open').map(r => r.conflict_id), requestId, Number(user.id)])).rows;
      const auditId = await auditService.record(tx, { event: 'mdf.demand_drift.resolved', entityType: 'mdf_demand_drift_conflict',
        entityId: conflictId, actorUserId: user.id, actorUsername: user.username, actorRole: user.role, requestId,
        source: 'backend-mdf-demand-drift', relatedOrderId: orderIds.length === 1 ? orderIds[0] : null,
        before: { status: 'open' }, after: { status: 'resolved', resolvedConflicts: resolved.map(r => r.conflict_id),
          reconciled: Boolean(group) },
        relatedEntities: orderIds.map(entityId => ({ entityType: 'order' as const, entityId })) });
      if (!auditId) throw new Error('MDF_DRIFT_AUDIT_FAILED');
      return { resolved: resolved.length };
    }, { mdf: { writer: 'mdf.demand_reconcile', capability: 'order-demand' } });
  }
}

function alreadyResolved(): ApiError {
  return new ApiError(409, 'MDF_DRIFT_ALREADY_RESOLVED', 'Расхождение уже разрешено');
}

function denied(requiredPermissions: string[]): ApiError {
  return new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав', { requiredPermissions });
}

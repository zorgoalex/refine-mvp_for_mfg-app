import type { DatabaseClient } from '../../../database/database.types';
import { auditService } from '../../../common/audit/audit.service';
import type { MdfJob } from '../application/mdf-job-runner';
import type { MdfRepublishMarker } from '../application/mdf-accepted-job';
import { mdfPositionKey, mdfSum } from '../domain/mdf-quantities';
import type { projectMdfAcceptedState, MdfAcceptedSource } from '../domain/mdf-accepted-projection';
import { mdfAttachedSourceLines } from '../domain/mdf-accepted-projection';
import { mdfSourceKey, type MdfExecutionMetadata } from './mdf-execution-snapshot';

/** Owning job transaction only; publication lock comes AFTER all domain locks.
 * Snapshot readers cannot see half-replaced positions/members or new card columns
 * with an old revision. No commit/hooks/network I/O at this boundary. */
export async function publishMdfState(tx: DatabaseClient, input: {
  job: MdfJob; orderIds: readonly number[]; sources: readonly MdfAcceptedSource[];
  metadata: ReadonlyMap<string,MdfExecutionMetadata>;
  state: ReturnType<typeof projectMdfAcceptedState>;
  /** §5.4b retired baths: their published card is removed (history stays in audit/evidence). */
  retired?: readonly { kind: string; id: string }[];
  /** §5.7b order-aggregate scope: position rows are replaced ONLY for these orders (open orders of the allocation
   * scope, plus a closed order in its own `order:X` closure job). Defaults to `orderIds`. */
  positionOrderIds?: readonly number[];
  /** Pieces of bath members closed by credited (declared) cut, beside the physical allocations. */
  declaredCoverage?: readonly MdfDeclaredCoverage[];
  /** Internal re-publication run (migration 277 marker): audited as such, never carries effects. */
  republish?: MdfRepublishMarker;
}) {
  const row = (await tx.query<{ revision: string; published_at: string }>(`SELECT published_revision::text revision,
    transaction_timestamp()::text published_at FROM mdf_engine_state WHERE singleton FOR UPDATE`)).rows[0];
  if (!row) throw new Error('MDF_PUBLICATION_STATE_MISSING');
  const revision = (BigInt(row.revision)+1n).toString();
  const cards = input.state.cards.map(card => {
    const source = input.sources.find(s => mdfSourceKey(s)===mdfSourceKey(card))!;
    const meta = input.metadata.get(mdfSourceKey(card));
    return { kind: card.kind, id: card.id, received: source.received, accepted: source.accepted,
      createdAt: meta?.sourceCreatedAt ?? null, displayName: meta?.displayName ?? null,
      column: card.column, reason: card.reason, issues: card.issues,
      // §5.4d: rank-independent placement inputs, bound to THIS publication revision (read-time placement).
      placementInputs: { schemaVersion: 1, publishedRevision: revision, ...card.placementInputs } };
  });
  // Readiness basis of the previous publication, read BEFORE this one replaces the rows.
  const publishedBaths = cards.filter(c => c.kind==='bath');
  const previousBasis = new Map((publishedBaths.length ? (await tx.query<{ id: string; ready: boolean; declared: string }>(
    `SELECT s.id,COALESCE(p.placement_inputs->>'bathReadiness'='ready',false) ready,
      COALESCE((SELECT sum(m.declared_covered_quantity) FROM mdf_published_source_members m
        WHERE m.source_kind='bath' AND m.source_id=s.id),0)::text declared
    FROM unnest($1::text[]) s(id) LEFT JOIN mdf_published_sources p ON p.source_kind='bath' AND p.source_id=s.id`,
  [publishedBaths.map(c => c.id)])).rows : []).map(r => [r.id,mdfBathReadinessBasis(r.ready,BigInt(r.declared) > 0n)]));
  await tx.query(`INSERT INTO mdf_published_sources(source_kind,source_id,received_revision_key,accepted_revision_key,
    source_created_at,display_name,column_key,reason,issues,published_revision,placement_inputs)
    SELECT c.kind,c.id,c.received,c.accepted,COALESCE(c."createdAt"::timestamptz,previous.source_created_at,r.created_at),
      COALESCE(c."displayName",previous.display_name,c.id),
      c."column",c.reason,c.issues,$2::bigint,c."placementInputs"
    FROM jsonb_to_recordset($1::jsonb) c(kind text,id text,received text,accepted text,"createdAt" text,
      "displayName" text,"column" text,reason text,issues text[],"placementInputs" jsonb)
    JOIN mdf_evidence_revisions r ON r.source_kind=c.kind AND r.source_id=c.id AND r.revision_key=c.received
    LEFT JOIN mdf_published_sources previous ON previous.source_kind=c.kind AND previous.source_id=c.id
    ON CONFLICT(source_kind,source_id) DO UPDATE SET received_revision_key=EXCLUDED.received_revision_key,
      accepted_revision_key=EXCLUDED.accepted_revision_key,source_created_at=EXCLUDED.source_created_at,
      display_name=EXCLUDED.display_name,column_key=EXCLUDED.column_key,reason=EXCLUDED.reason,
      issues=EXCLUDED.issues,published_revision=EXCLUDED.published_revision,
      placement_inputs=EXCLUDED.placement_inputs`,[JSON.stringify(cards),revision]);
  const members = new Map<string,{ kind: string; id: string; orderId: number; detailId: number; quantity: number }>();
  for (const source of input.sources) for (const line of mdfAttachedSourceLines(source)) if (line.stage==='membership') {
    const key = JSON.stringify([source.kind,source.id,line.orderId,line.detailId]);
    members.set(key,{ kind: source.kind,id: source.id,orderId: line.orderId,detailId: line.detailId,
      quantity: mdfSum(members.get(key)?.quantity ?? 0,line.quantity) });
  }
  await tx.query(`DELETE FROM mdf_published_source_members p USING unnest($1::text[],$2::text[]) s(kind,id)
    WHERE p.source_kind=s.kind AND p.source_id=s.id`,[cards.map(c => c.kind),cards.map(c => c.id)]);
  await tx.query(`INSERT INTO mdf_published_source_members(source_kind,source_id,order_id,detail_id,quantity)
    SELECT kind,id,"orderId","detailId",quantity FROM jsonb_to_recordset($1::jsonb)
      m(kind text,id text,"orderId" bigint,"detailId" bigint,quantity bigint)`,[JSON.stringify([...members.values()])]);
  // A bath's cut coverage is frozen with this publication (same job transaction as the allocation the projection used).
  const baths = input.sources.filter(s => s.kind==='bath' && cards.some(c => c.kind==='bath' && c.id===s.id));
  if (baths.length) await tx.query(`UPDATE mdf_published_source_members p SET covered_quantity=COALESCE((
      SELECT sum(a.quantity) FROM mdf_bath_allocations a WHERE a.bath_id=p.source_id AND a.bath_revision=s.revision
        AND a.order_id=p.order_id AND a.detail_id=p.detail_id AND a.state IN ('reserved','consumed')),0)
    FROM unnest($1::text[],$2::text[]) s(id,revision) WHERE p.source_kind='bath' AND p.source_id=s.id`,
  [baths.map(s => s.id),baths.map(s => s.received)]);
  // Credited-cut coverage of the same publication: only for a published bath of THIS accepted revision, never above
  // what the physical allocations leave (CHECK of migration 277 enforces it as well).
  const declared = (input.declaredCoverage ?? []).filter(d => baths.some(b => b.id===d.bathId && b.received===d.bathRevision));
  if (declared.length) await tx.query(`UPDATE mdf_published_source_members p
    SET declared_covered_quantity=d.quantity
    FROM jsonb_to_recordset($1::jsonb) d("bathId" text,"orderId" bigint,"detailId" bigint,quantity bigint)
    WHERE p.source_kind='bath' AND p.source_id=d."bathId" AND p.order_id=d."orderId" AND p.detail_id=d."detailId"`,
  [JSON.stringify(declared)]);
  const declaredBaths = new Set(declared.filter(d => d.quantity > 0).map(d => d.bathId));
  if (input.retired?.length) {
    const retired = [input.retired.map(r => r.kind), input.retired.map(r => r.id)];
    await tx.query(`DELETE FROM mdf_published_source_members p USING unnest($1::text[],$2::text[]) s(kind,id)
      WHERE p.source_kind=s.kind AND p.source_id=s.id`, retired);
    await tx.query(`DELETE FROM mdf_published_sources p USING unnest($1::text[],$2::text[]) s(kind,id)
      WHERE p.source_kind=s.kind AND p.source_id=s.id`, retired);
  }
  const positionOrderIds = input.positionOrderIds ?? input.orderIds;
  const positionOrders = new Set(positionOrderIds);
  await tx.query('DELETE FROM mdf_published_positions WHERE order_id=ANY($1::bigint[])',[positionOrderIds]);
  const positions = input.state.quantities.positions.filter(p => positionOrders.has(p.orderId))
    .map(p => ({ ...p, issues: input.state.positionIssues.get(mdfPositionKey(p)) ?? [] }));
  await tx.query(`INSERT INTO mdf_published_positions(order_id,detail_id,required_quantity,cut_quantity,rolled_quantity,
    credited_cut,credited_rolled,remaining,issues,published_revision)
    SELECT "orderId","detailId",quantity,cut,rolled,"creditedCut","creditedRolled",remaining,issues,$2::bigint
    FROM jsonb_to_recordset($1::jsonb) p("orderId" bigint,"detailId" bigint,quantity bigint,cut bigint,rolled bigint,
      "creditedCut" bigint,"creditedRolled" bigint,remaining bigint,issues text[])`,[JSON.stringify(positions),revision]);
  const auditId = await auditService.record(tx,{ event: 'mdf_board.projection_published', entityType: 'mdf_job',
    entityId: input.job.job_id, actorUserId: input.job.actor_user_id, requestId: input.job.request_id,
    source: 'backend-mdf-job', before: { revision: row.revision }, after: { revision },
    metadata: { causeKey: input.job.event_key, sourceKind: input.job.source_kind, sourceId: input.job.source_id,
      notificationEventDecision: 'derived_projection_only_domain_actions_own_outbox',
      cardCount: cards.length, positionCount: positions.length } });
  if (!auditId) throw new Error('MDF_PUBLICATION_AUDIT_FAILED');
  await tx.query(`INSERT INTO audit_log_related_entity(audit_id,entity_type,entity_id)
    SELECT $1::uuid,'order',unnest($2::bigint[]) UNION ALL SELECT $1::uuid,'order_detail',unnest($3::bigint[])
    ON CONFLICT DO NOTHING`,[auditId,input.orderIds,positions.map(p => p.detailId)]);
  if (input.republish) {
    const republishedId = await auditService.record(tx,{ event: 'mdf_board.republished', entityType: 'mdf_job',
      entityId: input.job.job_id, actorUserId: input.republish.actorUserId, requestId: input.republish.requestId,
      source: 'backend-mdf-job', before: { revision: row.revision }, after: { revision },
      metadata: { runId: input.republish.runId, commandKey: input.republish.commandKey,
        sourceKind: input.job.source_kind, sourceId: input.job.source_id, revisionKey: input.job.revision_key } });
    if (!republishedId) throw new Error('MDF_REPUBLISH_AUDIT_FAILED');
    await tx.query(`INSERT INTO audit_log_related_entity(audit_id,entity_type,entity_id)
      SELECT $1::uuid,'order',unnest($2::bigint[]) ON CONFLICT DO NOTHING`,[republishedId,input.orderIds]);
  }
  // Readiness basis of every published bath, compared with the previous publication: audited on each change, also when
  // no allocation changed (a basis can move between baths with the same physical ledger).
  for (const card of publishedBaths) {
    const before = previousBasis.get(card.id) ?? 'none';
    const after = mdfBathReadinessBasis(card.placementInputs.bathReadiness==='ready', declaredBaths.has(card.id));
    if (before === after) continue;
    const bathMembers = [...members.values()].filter(m => m.kind==='bath' && m.id===card.id);
    const changedId = await auditService.record(tx,{ event: 'mdf_board.bath_readiness_changed', entityType: 'mdf_bath',
      entityId: card.id, actorUserId: input.republish?.actorUserId ?? input.job.actor_user_id,
      requestId: input.republish?.requestId ?? input.job.request_id, source: 'backend-mdf-job',
      before: { basis: before }, after: { basis: after },
      metadata: { causeKey: input.job.event_key, jobId: input.job.job_id, publishedRevision: revision,
        bathRevision: card.accepted, declaredQuantity: declared.filter(d => d.bathId===card.id)
          .reduce((sum,d) => mdfSum(sum,d.quantity),0) } });
    if (!changedId) throw new Error('MDF_BATH_READINESS_AUDIT_FAILED');
    await tx.query(`INSERT INTO audit_log_related_entity(audit_id,entity_type,entity_id)
      SELECT $1::uuid,'order',unnest($2::bigint[]) UNION ALL SELECT $1::uuid,'order_detail',unnest($3::bigint[])
      ON CONFLICT DO NOTHING`,[changedId,[...new Set(bathMembers.map(m => m.orderId))],bathMembers.map(m => m.detailId)]);
  }
  await tx.query('UPDATE mdf_engine_state SET published_revision=$1,updated_at=now() WHERE singleton',[revision]);
  return revision;
}

export interface MdfDeclaredCoverage { bathId: string; bathRevision: string; orderId: number; detailId: number; quantity: number }
export type MdfBathReadinessBasis = 'physical' | 'declared' | 'none';

/** A ready bath is «declared» when credited cut closes at least one of its pieces, otherwise «physical». */
export function mdfBathReadinessBasis(ready: boolean, declared: boolean): MdfBathReadinessBasis {
  return !ready ? 'none' : declared ? 'declared' : 'physical';
}

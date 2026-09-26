import type { DatabaseClient } from '../../../database/database.types';
import { auditService } from '../../../common/audit/audit.service';
import type { MdfJob } from '../application/mdf-job-runner';
import { mdfPositionKey, mdfSum } from '../domain/mdf-quantities';
import type { projectMdfAcceptedState, MdfAcceptedSource } from '../domain/mdf-accepted-projection';
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
  for (const source of input.sources) for (const line of source.lines) if (line.stage==='membership') {
    const key = JSON.stringify([source.kind,source.id,line.orderId,line.detailId]);
    members.set(key,{ kind: source.kind,id: source.id,orderId: line.orderId,detailId: line.detailId,
      quantity: mdfSum(members.get(key)?.quantity ?? 0,line.quantity) });
  }
  await tx.query(`DELETE FROM mdf_published_source_members p USING unnest($1::text[],$2::text[]) s(kind,id)
    WHERE p.source_kind=s.kind AND p.source_id=s.id`,[cards.map(c => c.kind),cards.map(c => c.id)]);
  await tx.query(`INSERT INTO mdf_published_source_members(source_kind,source_id,order_id,detail_id,quantity)
    SELECT kind,id,"orderId","detailId",quantity FROM jsonb_to_recordset($1::jsonb)
      m(kind text,id text,"orderId" bigint,"detailId" bigint,quantity bigint)`,[JSON.stringify([...members.values()])]);
  if (input.retired?.length) {
    const retired = [input.retired.map(r => r.kind), input.retired.map(r => r.id)];
    await tx.query(`DELETE FROM mdf_published_source_members p USING unnest($1::text[],$2::text[]) s(kind,id)
      WHERE p.source_kind=s.kind AND p.source_id=s.id`, retired);
    await tx.query(`DELETE FROM mdf_published_sources p USING unnest($1::text[],$2::text[]) s(kind,id)
      WHERE p.source_kind=s.kind AND p.source_id=s.id`, retired);
  }
  await tx.query('DELETE FROM mdf_published_positions WHERE order_id=ANY($1::bigint[])',[input.orderIds]);
  const positions = input.state.quantities.positions.map(p => ({ ...p, issues: input.state.positionIssues.get(mdfPositionKey(p)) ?? [] }));
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
  await tx.query('UPDATE mdf_engine_state SET published_revision=$1,updated_at=now() WHERE singleton',[revision]);
  return revision;
}

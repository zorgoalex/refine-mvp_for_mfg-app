import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import {
  issueMdfValidatedPhysicalLineage,
  type MdfLineageAction, type MdfLineageOperation, type MdfLineageSourceKind,
  type MdfValidatedPhysicalLine, type MdfValidatedPhysicalLineage,
} from '../domain/mdf-physical-lineage';
import { mdfPhysicalLineageDigest, type MdfPhysicalLineageAction, type MdfPhysicalLineageManifest } from '../application/mdf-physical-lineage';
import type { MdfSourceKind } from '../application/mdf-job-runner';
import { matchesMdfValidatedBazisAssignmentState, type MdfValidatedBazisAssignmentState }
  from '../application/mdf-bazis-assignment-state';
import { mdfPositionKey, mdfSum } from '../domain/mdf-quantities';
import { isMdfEvidenceContract } from '../domain/mdf-evidence-contract';

const MAX_REVISIONS = 1000;
const MAX_LINES = 50000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const key = (kind: string, id: string, revision: string) => JSON.stringify([kind,id,revision]);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export interface MdfLineageHead {
  kind: MdfSourceKind;
  id: string;
  accepted: string | null;
  received: string;
}

interface RequestedRevision { kind: MdfSourceKind; id: string; revision: string }
interface ContractRow extends QueryResultRow {
  kind: MdfSourceKind; id: string; revision: string;
  contractFound: boolean; sourceHasContract: boolean; sealed: boolean; contextFound: boolean;
  sourceKind: MdfLineageSourceKind | null; operation: string | null; productionAuthority: string | null;
  predecessorRevision: string | null; manifestDigest: string | null; dropped: string[] | null;
  origin: string | null; acceptanceRequested: boolean | null; compositionComplete: boolean | null;
  effectPolicy: string | null; contextPredecessorAccepted: string | null; contextPredecessorReceived: string | null;
}
interface EvidenceRow extends QueryResultRow {
  kind: MdfSourceKind; id: string; revision: string; evidenceLineId: string; lineKey: string;
  orderId: number; detailId: number; quantity: number; stageCode: string; evidenceKind: string; rework: boolean;
}
interface TransitionRow extends QueryResultRow {
  kind: MdfSourceKind; id: string; revision: string; evidenceLineId: string; action: string;
  predecessorEvidenceLineId: string | null; canonicalOriginEvidenceLineId: string;
  childKind: MdfSourceKind | null; childId: string | null; childRevision: string | null;
  childEvidenceKind: string | null; childLineKey: string | null; childOrderId: number | null;
  childDetailId: number | null; childQuantity: number | null; childStage: string | null; childRework: boolean | null;
  parentEvidenceLineId: string | null; parentKind: MdfSourceKind | null; parentId: string | null; parentRevision: string | null;
  parentEvidenceKind: string | null; parentLineKey: string | null; parentOrderId: number | null;
  parentDetailId: number | null; parentQuantity: number | null; parentStage: string | null; parentRework: boolean | null;
  parentCanonicalOrigin: string | null; parentLineageOperation: string | null;
}
interface ParentRow extends QueryResultRow {
  kind: MdfSourceKind; id: string; revision: string; evidenceLineId: string; canonicalOriginEvidenceLineId: string | null;
  lineageContractFound: boolean;
}

export interface MdfPhysicalLineageSnapshot {
  /** Only revisions with a validated v2 contract appear here. */
  lineage: Map<string,MdfValidatedPhysicalLineage>;
  /** Invalid v2 keys are quarantined; absence is legacy v1 only. */
  lineageIssues: Map<string,string[]>;
}

/** Batch-load only accepted/received head revisions. Migration 182 is mandatory;
 * SQL errors are intentionally allowed to escape instead of treating missing
 * lineage tables as legacy v1. The immutable seal guard authenticates the
 * historical chain; this loader checks its immediate parent and exact children.
 * An issued intentional-empty bazisCutSet assignment descriptor passed through
 * options is the only substitute for nonempty membership evidence. */
export async function loadMdfPhysicalLineageSnapshot(tx: DatabaseClient,
  heads: readonly MdfLineageHead[],
  options:{assignmentStates?:ReadonlyMap<string,MdfValidatedBazisAssignmentState>}={}): Promise<MdfPhysicalLineageSnapshot> {
  const requested = new Map<string,RequestedRevision>();
  for (const head of heads) {
    if (head.kind !== 'packet' && head.kind !== 'bazisCutSet' && head.kind !== 'bath') continue;
    for (const revision of [head.accepted,head.received]) if (revision) {
      const row = { kind:head.kind,id:head.id,revision };
      requested.set(key(row.kind,row.id,row.revision),row);
    }
  }
  if (!requested.size) return { lineage:new Map(),lineageIssues:new Map() };
  if (requested.size > MAX_REVISIONS) throw new Error('MDF_LINEAGE_LIMIT');
  const revisions = [...requested.values()].sort((a,b)=>compare(key(a.kind,a.id,a.revision),key(b.kind,b.id,b.revision)));
  const kinds = revisions.map(r=>r.kind), ids = revisions.map(r=>r.id), revs = revisions.map(r=>r.revision);
  const contracts = (await tx.query<ContractRow>(`WITH wanted AS (
      SELECT * FROM unnest($1::text[],$2::text[],$3::text[]) AS w(kind,id,revision)
    )
    SELECT w.kind,w.id,w.revision,(c.source_kind IS NOT NULL) "contractFound",
      EXISTS(SELECT 1 FROM mdf_physical_lineage_contracts any_c
        WHERE any_c.source_kind=w.kind AND any_c.source_id=w.id) "sourceHasContract",
      (z.revision_key IS NOT NULL) sealed,(ctx.revision_key IS NOT NULL) "contextFound",
      c.source_kind "sourceKind",c.operation,c.production_authority "productionAuthority",
      c.predecessor_accepted_revision_key "predecessorRevision",c.manifest_digest "manifestDigest",
      c.dropped_predecessor_evidence_line_ids::text[] dropped,r.origin,
      ctx.acceptance_requested "acceptanceRequested",ctx.composition_complete "compositionComplete",
      ctx.effect_policy "effectPolicy",ctx.predecessor_accepted_revision_key "contextPredecessorAccepted",
      ctx.predecessor_received_revision_key "contextPredecessorReceived"
    FROM wanted w
    LEFT JOIN mdf_physical_lineage_contracts c ON c.source_kind=w.kind AND c.source_id=w.id AND c.revision_key=w.revision
    LEFT JOIN mdf_evidence_revisions r ON r.source_kind=w.kind AND r.source_id=w.id AND r.revision_key=w.revision
    LEFT JOIN mdf_revision_context ctx ON ctx.source_kind=w.kind AND ctx.source_id=w.id AND ctx.revision_key=w.revision
    LEFT JOIN mdf_revision_seals z ON z.source_kind=w.kind AND z.source_id=w.id AND z.revision_key=w.revision
    ORDER BY w.kind,w.id,w.revision`,[kinds,ids,revs])).rows;
  const contractByRevision = new Map(contracts.map(row=>[key(row.kind,row.id,row.revision),row]));
  const evidence = (await tx.query<EvidenceRow>(`SELECT l.source_kind kind,l.source_id id,l.revision_key revision,
      l.evidence_line_id::text "evidenceLineId",l.line_key "lineKey",l.order_id::float8 "orderId",
      l.detail_id::float8 "detailId",l.quantity::float8 quantity,l.stage_code "stageCode",
      l.evidence_kind "evidenceKind",l.rework
    FROM unnest($1::text[],$2::text[],$3::text[]) w(kind,id,revision)
    JOIN mdf_evidence_lines l ON l.source_kind=w.kind AND l.source_id=w.id AND l.revision_key=w.revision
    ORDER BY l.source_kind,l.source_id,l.revision_key,l.evidence_line_id LIMIT $4`,[kinds,ids,revs,MAX_LINES+1])).rows;
  if (evidence.length>MAX_LINES) throw new Error('MDF_LINEAGE_LIMIT');

  const lineageContracts = contracts.filter(row=>row.contractFound);
  const lineageKinds = lineageContracts.map(row=>row.kind), lineageIds = lineageContracts.map(row=>row.id),
    lineageRevisions = lineageContracts.map(row=>row.revision);
  const transitions = lineageContracts.length ? (await tx.query<TransitionRow>(`SELECT t.source_kind kind,t.source_id id,
      t.revision_key revision,t.evidence_line_id::text "evidenceLineId",t.action,
      t.predecessor_evidence_line_id::text "predecessorEvidenceLineId",
      t.canonical_origin_evidence_line_id::text "canonicalOriginEvidenceLineId",
      child.source_kind "childKind",child.source_id "childId",child.revision_key "childRevision",
      child.evidence_kind "childEvidenceKind",child.line_key "childLineKey",child.order_id::float8 "childOrderId",
      child.detail_id::float8 "childDetailId",child.quantity::float8 "childQuantity",child.stage_code "childStage",child.rework "childRework",
      parent.evidence_line_id::text "parentEvidenceLineId",parent.source_kind "parentKind",parent.source_id "parentId",parent.revision_key "parentRevision",
      parent.evidence_kind "parentEvidenceKind",parent.line_key "parentLineKey",parent.order_id::float8 "parentOrderId",
      parent.detail_id::float8 "parentDetailId",parent.quantity::float8 "parentQuantity",parent.stage_code "parentStage",
      parent.rework "parentRework",parent_t.canonical_origin_evidence_line_id::text "parentCanonicalOrigin",
      parent_c.operation "parentLineageOperation"
    FROM unnest($1::text[],$2::text[],$3::text[]) w(kind,id,revision)
    JOIN mdf_physical_lineage_transitions t ON t.source_kind=w.kind AND t.source_id=w.id AND t.revision_key=w.revision
    LEFT JOIN mdf_evidence_lines child ON child.evidence_line_id=t.evidence_line_id
    LEFT JOIN mdf_evidence_lines parent ON parent.evidence_line_id=t.predecessor_evidence_line_id
    LEFT JOIN mdf_physical_lineage_transitions parent_t ON parent_t.evidence_line_id=parent.evidence_line_id
      AND parent_t.source_kind=parent.source_kind AND parent_t.source_id=parent.source_id AND parent_t.revision_key=parent.revision_key
    LEFT JOIN mdf_physical_lineage_contracts parent_c ON parent_c.source_kind=parent.source_kind
      AND parent_c.source_id=parent.source_id AND parent_c.revision_key=parent.revision_key
    ORDER BY t.source_kind,t.source_id,t.revision_key,t.evidence_line_id LIMIT $4`,
  [lineageKinds,lineageIds,lineageRevisions,MAX_LINES+1])).rows : [];
  if (transitions.length>MAX_LINES) throw new Error('MDF_LINEAGE_LIMIT');

  const parentRequests = lineageContracts.flatMap(row=>row.predecessorRevision
    ? [{kind:row.kind,id:row.id,revision:row.predecessorRevision}] : []);
  const parentUnique = new Map(parentRequests.map(row=>[key(row.kind,row.id,row.revision),row]));
  const parentRows = parentUnique.size ? (await tx.query<ParentRow>(`SELECT p.source_kind kind,p.source_id id,p.revision_key revision,
      p.evidence_line_id::text "evidenceLineId",pt.canonical_origin_evidence_line_id::text "canonicalOriginEvidenceLineId",
      (pc.source_kind IS NOT NULL) "lineageContractFound"
    FROM unnest($1::text[],$2::text[],$3::text[]) w(kind,id,revision)
    JOIN mdf_evidence_lines p ON p.source_kind=w.kind AND p.source_id=w.id AND p.revision_key=w.revision
      AND p.evidence_kind='physical'
    LEFT JOIN mdf_physical_lineage_transitions pt ON pt.source_kind=p.source_kind AND pt.source_id=p.source_id
      AND pt.revision_key=p.revision_key AND pt.evidence_line_id=p.evidence_line_id
    LEFT JOIN mdf_physical_lineage_contracts pc ON pc.source_kind=p.source_kind AND pc.source_id=p.source_id
      AND pc.revision_key=p.revision_key
    ORDER BY p.source_kind,p.source_id,p.revision_key,p.evidence_line_id LIMIT $4`,
  [[...parentUnique.values()].map(r=>r.kind),[...parentUnique.values()].map(r=>r.id),
    [...parentUnique.values()].map(r=>r.revision),MAX_LINES+1])).rows : [];
  if (parentRows.length>MAX_LINES) throw new Error('MDF_LINEAGE_LIMIT');
  const parentIds = new Set(parentRows.map(row=>row.evidenceLineId.toLowerCase()));
  const currentLines = new Map<string,EvidenceRow[]>();
  for (const line of evidence) {
    const revisionKey = key(line.kind,line.id,line.revision), rows=currentLines.get(revisionKey)??[];
    rows.push(line); currentLines.set(revisionKey,rows);
  }
  const transitionGroups = new Map<string,TransitionRow[]>();
  for (const row of transitions) {
    const revisionKey=key(row.kind,row.id,row.revision), rows=transitionGroups.get(revisionKey)??[];
    rows.push(row); transitionGroups.set(revisionKey,rows);
  }
  const parentLineageById = new Map(parentRows.map(row=>[row.evidenceLineId.toLowerCase(),row]));
  const parentsByRevision=new Map<string,ParentRow[]>();
  for (const row of parentRows) {
    const parentKey=key(row.kind,row.id,row.revision), rows=parentsByRevision.get(parentKey)??[];
    rows.push(row); parentsByRevision.set(parentKey,rows);
  }
  const result: MdfPhysicalLineageSnapshot = { lineage:new Map(),lineageIssues:new Map() };
  for (const revision of revisions) {
    const revisionKey=key(revision.kind,revision.id,revision.revision), contract=contractByRevision.get(revisionKey);
    if (!contract?.contractFound) {
      if (contract?.sourceHasContract) result.lineageIssues.set(revisionKey,['MDF_LINEAGE_REQUIRED']);
      continue;
    }
    try {
      const descriptor=validateAndIssue(contract,currentLines.get(revisionKey)??[],transitionGroups.get(revisionKey)??[],
        parentLineageById,parentIds,parentsByRevision,options.assignmentStates?.get(revisionKey));
      result.lineage.set(revisionKey,descriptor);
    } catch {
      result.lineageIssues.set(revisionKey,['MDF_LINEAGE_INVALID']);
    }
  }
  return result;
}

function validateAndIssue(contract: ContractRow,evidence: readonly EvidenceRow[],transitions: readonly TransitionRow[],
  parents: ReadonlyMap<string,ParentRow>,parentIds: ReadonlySet<string>,parentsByRevision: ReadonlyMap<string,ParentRow[]>,
  assignmentState?: MdfValidatedBazisAssignmentState): MdfValidatedPhysicalLineage {
  if (!contract.sealed||!contract.contextFound||!contract.acceptanceRequested||!contract.compositionComplete
    || contract.sourceKind!==contract.kind || !contract.origin || !contract.operation
    || !contract.manifestDigest || !/^[a-f0-9]{64}$/.test(contract.manifestDigest)
    || !Array.isArray(contract.dropped) || !['production','carry','correction'].includes(contract.operation)
    || !contract.predecessorRevision?.trim() && contract.predecessorRevision!==null
    || contract.contextPredecessorAccepted!==contract.predecessorRevision
    || contract.contextPredecessorReceived!==contract.predecessorRevision
    || (contract.operation==='correction'
      ? contract.origin!=='manual'||contract.effectPolicy!=='publish_only'
      : contract.effectPolicy!=='forward')) throw new Error('MDF_LINEAGE_INVALID');
  const operation=contract.operation as MdfLineageOperation;
  const authority=contract.productionAuthority;
  if ((operation==='production' && authority!=='manual_production' && authority!=='cnc_observation')
    || (operation!=='production' && authority!==null)
    || (authority==='manual_production'&&contract.origin!=='manual')
    || (authority==='cnc_observation'&&(contract.origin!=='cnc'||contract.kind!=='packet'))
    || (operation==='carry' && contract.origin!=='manual')
    ) throw new Error('MDF_LINEAGE_INVALID');
  const allLineIds=new Set(evidence.map(line=>line.evidenceLineId.toLowerCase()));
  if (allLineIds.size!==evidence.length || evidence.some(line=>line.kind!==contract.kind || line.id!==contract.id
    || line.revision!==contract.revision || !Number.isSafeInteger(line.orderId)||line.orderId<=0
    || !Number.isSafeInteger(line.detailId)||line.detailId<=0 || !Number.isSafeInteger(line.quantity)||line.quantity<=0
    || !line.lineKey || line.lineKey.includes('\0') || typeof line.rework!=='boolean'
    || !isMdfEvidenceContract(contract.kind,line.stageCode,line.evidenceKind))) throw new Error('MDF_LINEAGE_INVALID');
  const physical=evidence.filter(line=>line.evidenceKind==='physical');
  const transitionsById=new Map(transitions.map(row=>[row.evidenceLineId.toLowerCase(),row]));
  if (transitionsById.size!==transitions.length || transitions.length!==physical.length
    || evidence.some(line=>line.evidenceKind!=='physical' && transitionsById.has(line.evidenceLineId.toLowerCase()))) {
    throw new Error('MDF_LINEAGE_INVALID');
  }
  const dropped=contract.dropped.map(id=>String(id).toLowerCase());
  if (dropped.some(id=>!UUID.test(id)) || dropped.some((id,index)=>index>0&&compare(dropped[index-1],id)>=0)) {
    throw new Error('MDF_LINEAGE_INVALID');
  }
  const usedParents=new Set<string>();
  const lines: MdfValidatedPhysicalLine[]=[];
  const actions: MdfPhysicalLineageAction[]=[];
  const canonicalOrigins=new Set<string>();
  for (const child of physical) {
    const transition=transitionsById.get(child.evidenceLineId.toLowerCase());
    if (!transition || (child.stageCode!=='cut'&&child.stageCode!=='laminated')
      || child.stageCode!==(contract.kind==='bath'?'laminated':'cut')
      || transition.childKind!==contract.kind || transition.childId!==contract.id
      || transition.childRevision!==contract.revision || transition.childEvidenceKind!=='physical'
      || transition.childLineKey!==child.lineKey || transition.childOrderId!==child.orderId
      || transition.childDetailId!==child.detailId || transition.childQuantity!==child.quantity
      || transition.childStage!==child.stageCode || transition.childRework!==child.rework
      || !UUID.test(transition.canonicalOriginEvidenceLineId)) throw new Error('MDF_LINEAGE_INVALID');
    const action=transition.action as MdfLineageAction;
    const predecessor=transition.predecessorEvidenceLineId?.toLowerCase()??null;
    const canonical=transition.canonicalOriginEvidenceLineId.toLowerCase();
    if (!['root','carry','reduce'].includes(action)) throw new Error('MDF_LINEAGE_INVALID');
    if (action==='root') {
      if (predecessor!==null || canonical!==child.evidenceLineId.toLowerCase()
        || child.stageCode!==(contract.kind==='bath'?'laminated':'cut') || operation!=='production') throw new Error('MDF_LINEAGE_INVALID');
    } else {
      if (!predecessor || !contract.predecessorRevision || usedParents.has(predecessor)) throw new Error('MDF_LINEAGE_INVALID');
      const parent=transition.parentEvidenceLineId?.toLowerCase()===predecessor
        ? {
          kind:transition.parentKind,id:transition.parentId,revision:transition.parentRevision,
          evidenceKind:transition.parentEvidenceKind,lineKey:transition.parentLineKey,orderId:transition.parentOrderId,
          detailId:transition.parentDetailId,quantity:transition.parentQuantity,stage:transition.parentStage,
          rework:transition.parentRework,canonicalOrigin:transition.parentCanonicalOrigin,
          operation:transition.parentLineageOperation,
      } : null;
      if (!parent || parent.kind!==contract.kind || parent.id!==contract.id || parent.revision!==contract.predecessorRevision
        || parent.evidenceKind!=='physical' || !parent.lineKey || parent.orderId!==child.orderId
        || parent.detailId!==child.detailId || parent.stage!==child.stageCode || parent.rework!==child.rework
        || parent.quantity===null || !Number.isSafeInteger(parent.quantity) || parent.quantity<=0
        || !parent.canonicalOrigin || parent.canonicalOrigin.toLowerCase()!==canonical || !parent.operation
        || !parentIds.has(predecessor) || !parents.has(predecessor)) throw new Error('MDF_LINEAGE_INVALID');
      if ((action==='carry' && child.quantity!==parent.quantity)
        || (action==='reduce' && (operation!=='correction'||child.quantity>=parent.quantity))
        || (operation==='carry'&&action!=='carry')) {
        throw new Error('MDF_LINEAGE_INVALID');
      }
      usedParents.add(predecessor);
    }
    if (canonicalOrigins.has(canonical)) throw new Error('MDF_LINEAGE_INVALID');
    canonicalOrigins.add(canonical);
    lines.push({ evidenceLineId:child.evidenceLineId.toLowerCase(),lineKey:child.lineKey,orderId:child.orderId,
      detailId:child.detailId,quantity:child.quantity,stageCode:child.stageCode as 'cut'|'laminated',
      evidenceKind:'physical',rework:child.rework,action,predecessorEvidenceLineId:predecessor,
      canonicalOriginEvidenceLineId:canonical });
    actions.push(action==='root'?{lineKey:child.lineKey,action:'root'}:
      {lineKey:child.lineKey,action,predecessorEvidenceLineId:predecessor!});
  }
  if (contract.predecessorRevision===null) {
    if (usedParents.size||dropped.length) throw new Error('MDF_LINEAGE_INVALID');
  } else {
    const expectedRows=parentsByRevision.get(key(contract.kind,contract.id,contract.predecessorRevision))??[];
    if (expectedRows.some(row=>!row.lineageContractFound||!row.canonicalOriginEvidenceLineId
      ||!UUID.test(row.canonicalOriginEvidenceLineId))) throw new Error('MDF_LINEAGE_INVALID');
    const expectedParents=expectedRows.map(row=>row.evidenceLineId.toLowerCase());
    const represented=new Set([...usedParents,...dropped]);
    if (represented.size!==usedParents.size+dropped.length || expectedParents.length!==represented.size
      || expectedParents.some(id=>!represented.has(id)) || dropped.some(id=>usedParents.has(id))) throw new Error('MDF_LINEAGE_INVALID');
  }
  if ((operation==='production' && (dropped.length>0||actions.some(a=>a.action==='reduce')))
    || (operation==='carry'&&(dropped.length>0||actions.some(a=>a.action!=='carry')))) throw new Error('MDF_LINEAGE_INVALID');
  const members=new Map<string,number>(),roots=new Map<string,number>(),carried=new Map<string,number>(),physicalTotals=new Map<string,number>();
  for (const row of evidence) if (row.evidenceKind==='derived'&&row.stageCode==='membership') {
    const id=JSON.stringify([mdfPositionKey(row),row.rework]);
    members.set(id,mdfSum(members.get(id)??0,row.quantity));
  }
  if (!members.size && !(contract.kind==='bazisCutSet' && assignmentState?.intentionalEmpty===true
    && matchesMdfValidatedBazisAssignmentState({sourceKind:contract.kind,sourceId:contract.id,
      revisionKey:contract.revision,lines:evidence,state:assignmentState}))) throw new Error('MDF_LINEAGE_INVALID');
  for (const line of lines) {
    const id=JSON.stringify([mdfPositionKey(line),line.rework]);
    physicalTotals.set(id,mdfSum(physicalTotals.get(id)??0,line.quantity));
    const totals=line.action==='root'?roots:carried;
    totals.set(id,mdfSum(totals.get(id)??0,line.quantity));
  }
  if ([...roots].some(([id,quantity])=>quantity>Math.max(0,(members.get(id)??0)-(carried.get(id)??0)))
    || [...physicalTotals.values()].some(quantity=>!Number.isSafeInteger(quantity)||quantity<=0)) throw new Error('MDF_LINEAGE_INVALID');
  const manifest:MdfPhysicalLineageManifest = operation==='production'
    ? {operation,authority:authority as 'manual_production'|'cnc_observation',
        actions:actions.sort((a,b)=>compare(a.lineKey,b.lineKey)),droppedPredecessorEvidenceLineIds:[]}
    : operation==='carry' ? {operation,actions:actions.sort((a,b)=>compare(a.lineKey,b.lineKey)),droppedPredecessorEvidenceLineIds:[]}
      : {operation,actions:actions.sort((a,b)=>compare(a.lineKey,b.lineKey)),droppedPredecessorEvidenceLineIds:dropped};
  if (mdfPhysicalLineageDigest(manifest)!==contract.manifestDigest) throw new Error('MDF_LINEAGE_INVALID');
  return issueMdfValidatedPhysicalLineage({ sourceKind:contract.kind,sourceId:contract.id,revisionKey:contract.revision,
    operation,productionAuthority:authority as MdfValidatedPhysicalLineage['productionAuthority'],
    predecessorAcceptedRevisionKey:contract.predecessorRevision,manifestDigest:contract.manifestDigest,
    droppedPredecessorEvidenceLineIds:dropped,lines });
}

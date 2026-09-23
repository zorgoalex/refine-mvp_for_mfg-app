import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import { mdfSum } from '../domain/mdf-quantities';
import type { MdfSourceKind } from './mdf-job-runner';

export {
  isIssuedMdfPhysicalLineage,
  matchesMdfValidatedPhysicalLineage,
  mdfLineageRevisionKey,
  type MdfLineageAction,
  type MdfLineageOperation,
  type MdfLineageSourceKind,
  type MdfValidatedPhysicalLine,
  type MdfValidatedPhysicalLineage,
} from '../domain/mdf-physical-lineage';

export type MdfPhysicalLineageAction =
  | { lineKey: string; action: 'root' }
  | { lineKey: string; action: 'carry' | 'reduce'; predecessorEvidenceLineId: string };

export type MdfPhysicalLineageManifest =
  | {
      operation: 'production';
      authority: 'manual_production' | 'cnc_observation';
      actions: readonly MdfPhysicalLineageAction[];
      droppedPredecessorEvidenceLineIds: readonly [];
    }
  | {
      operation: 'carry';
      authority?: never;
      actions: readonly MdfPhysicalLineageAction[];
      droppedPredecessorEvidenceLineIds: readonly [];
    }
  | {
      operation: 'correction';
      authority?: never;
      actions: readonly MdfPhysicalLineageAction[];
      droppedPredecessorEvidenceLineIds: readonly string[];
    };

export interface MdfPhysicalLineageManifestLine {
  lineKey: string;
  evidenceKind: 'physical' | 'declaration' | 'derived';
}

export interface MdfPhysicalLineageReceiptLine extends MdfPhysicalLineageManifestLine {
  evidenceLineId: string;
  orderId: number;
  detailId: number;
  quantity: number;
  stageCode: string;
  rework: boolean;
}

interface PreviousPhysicalLine extends MdfPhysicalLineageReceiptLine {
  canonicalOriginEvidenceLineId: string | null;
}

interface CurrentLineRow extends QueryResultRow, MdfPhysicalLineageReceiptLine {}
interface PreviousLineRow extends QueryResultRow, PreviousPhysicalLine {}

export interface PersistMdfPhysicalLineageInput {
  sourceKind: MdfSourceKind;
  sourceId: string;
  revisionKey: string;
  predecessorAcceptedRevisionKey: string | null;
  manifestDigest: string;
  manifest: MdfPhysicalLineageManifest;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Freeze/normalize the server-owned transition manifest before the receipt's
 * first await. Caller canonical-origin claims are intentionally not part of the
 * API; roots are self-originating and carry/reduce origins are resolved in SQL. */
export function snapshotMdfPhysicalLineage(
  manifest: MdfPhysicalLineageManifest,
  lines: readonly MdfPhysicalLineageManifestLine[],
): MdfPhysicalLineageManifest {
  if (!manifest || !['production', 'carry', 'correction'].includes(manifest.operation)
    || !Array.isArray(manifest.actions) || !Array.isArray(manifest.droppedPredecessorEvidenceLineIds)) {
    throw new Error('MDF_LINEAGE_INVALID');
  }
  const physicalKeys = lines.filter(line => line.evidenceKind === 'physical').map(line => line.lineKey).sort();
  const nonPhysicalKeys = new Set(lines.filter(line => line.evidenceKind !== 'physical').map(line => line.lineKey));
  const actions = manifest.actions.map(action => {
    if (!action || typeof action.lineKey !== 'string' || !action.lineKey.trim() || action.lineKey.includes('\0')) {
      throw new Error('MDF_LINEAGE_INVALID');
    }
    if (action.action === 'root') return { lineKey: action.lineKey, action: 'root' as const };
    if ((action.action !== 'carry' && action.action !== 'reduce')
      || typeof action.predecessorEvidenceLineId !== 'string' || !UUID.test(action.predecessorEvidenceLineId)) {
      throw new Error('MDF_LINEAGE_INVALID');
    }
    return { lineKey: action.lineKey, action: action.action, predecessorEvidenceLineId: action.predecessorEvidenceLineId.toLowerCase() };
  }).sort((a, b) => a.lineKey < b.lineKey ? -1 : a.lineKey > b.lineKey ? 1 : 0);
  const actionKeys = actions.map(action => action.lineKey);
  if (actionKeys.some((key, index) => index > 0 && key === actionKeys[index - 1])
    || physicalKeys.length !== actionKeys.length || physicalKeys.some((key, index) => key !== actionKeys[index])
    || actions.some(action => nonPhysicalKeys.has(action.lineKey))) {
    throw new Error('MDF_LINEAGE_INVALID');
  }

  const dropped = manifest.droppedPredecessorEvidenceLineIds.map(id => {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('MDF_LINEAGE_INVALID');
    return id.toLowerCase();
  }).sort();
  if (dropped.some((id, index) => index > 0 && id === dropped[index - 1])) throw new Error('MDF_LINEAGE_INVALID');

  if (manifest.operation === 'production') {
    if (!['manual_production', 'cnc_observation'].includes(manifest.authority)
      || actions.some(action => action.action === 'reduce') || dropped.length > 0) throw new Error('MDF_LINEAGE_INVALID');
    return { operation: 'production', authority: manifest.authority, actions, droppedPredecessorEvidenceLineIds: [] };
  }
  if (manifest.operation === 'carry') {
    if ('authority' in manifest && manifest.authority !== undefined
      || actions.some(action => action.action !== 'carry') || dropped.length > 0) throw new Error('MDF_LINEAGE_INVALID');
    return { operation: 'carry', actions, droppedPredecessorEvidenceLineIds: [] };
  }
  if ('authority' in manifest && manifest.authority !== undefined
    || actions.some(action => action.action === 'root')) throw new Error('MDF_LINEAGE_INVALID');
  return { operation: 'correction', actions, droppedPredecessorEvidenceLineIds: dropped };
}

export function mdfPhysicalLineageDigest(manifest: MdfPhysicalLineageManifest): string {
  return createHash('sha256').update(JSON.stringify(['mdf-physical-lineage-v2', manifest])).digest('hex');
}

/** Persist the v2 manifest and its server-derived transition rows before the
 * receipt seal. Semantic checks are repeated by the migration's seal trigger so
 * direct SQL cannot bypass the source/revision/quantity contract. */
export async function persistMdfPhysicalLineage(tx: DatabaseClient,
  input: PersistMdfPhysicalLineageInput): Promise<void> {
  const currentRows = (await tx.query<CurrentLineRow>(`SELECT evidence_line_id::text "evidenceLineId",
      line_key "lineKey",order_id::float8 "orderId",detail_id::float8 "detailId",quantity::float8 quantity,
      stage_code "stageCode",evidence_kind "evidenceKind",rework
    FROM mdf_evidence_lines WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3
    ORDER BY line_key LIMIT 10001`, [input.sourceKind,input.sourceId,input.revisionKey])).rows;
  if (currentRows.length>10000) invalidLineage();

  const previousRows = input.predecessorAcceptedRevisionKey === null ? []
    : (await tx.query<PreviousLineRow>(`SELECT e.evidence_line_id::text "evidenceLineId",e.line_key "lineKey",
        e.order_id::float8 "orderId",e.detail_id::float8 "detailId",e.quantity::float8 quantity,
        e.stage_code "stageCode",e.evidence_kind "evidenceKind",e.rework,
        t.canonical_origin_evidence_line_id::text "canonicalOriginEvidenceLineId"
      FROM mdf_evidence_lines e LEFT JOIN mdf_physical_lineage_transitions t
        ON t.evidence_line_id=e.evidence_line_id
      WHERE e.source_kind=$1 AND e.source_id=$2 AND e.revision_key=$3 AND e.evidence_kind='physical'
      ORDER BY e.evidence_line_id LIMIT 10001`,
    [input.sourceKind,input.sourceId,input.predecessorAcceptedRevisionKey])).rows;
  if (previousRows.length>10000) invalidLineage();

  const previousById = new Map(previousRows.map(line => [line.evidenceLineId.toLowerCase(),line]));
  const actionByKey = new Map(input.manifest.actions.map(action => [action.lineKey,action]));
  const dropped = new Set(input.manifest.droppedPredecessorEvidenceLineIds);
  const predecessorUse = new Set<string>();
  const membershipByPosition = new Map<string,number>();
  for (const line of currentRows) {
    if (line.evidenceKind==='derived' && line.stageCode==='membership') {
      const key = positionKey(line.orderId,line.detailId,line.rework);
      membershipByPosition.set(key,lineageSum(membershipByPosition.get(key) ?? 0,line.quantity));
    }
  }
  const carriedByPosition = new Map<string,number>();
  const rootsByPosition = new Map<string,number>();
  const physicalByPosition = new Map<string,number>();
  const transitions: Array<{ evidenceLineId:string; action:'root'|'carry'|'reduce';
    predecessorEvidenceLineId:string|null; canonicalOriginEvidenceLineId:string }> = [];

  if (previousRows.some(parent => !parent.canonicalOriginEvidenceLineId)) invalidLineage();

  for (const child of currentRows.filter(line => line.evidenceKind==='physical')) {
    const physicalKey = positionKey(child.orderId,child.detailId,child.rework);
    physicalByPosition.set(physicalKey,lineageSum(physicalByPosition.get(physicalKey) ?? 0,child.quantity));
    const action = actionByKey.get(child.lineKey);
    if (!action) invalidLineage();
    if (action.action==='root') {
      if (input.manifest.operation!=='production') invalidLineage();
      const key = positionKey(child.orderId,child.detailId,child.rework);
      rootsByPosition.set(key,lineageSum(rootsByPosition.get(key) ?? 0,child.quantity));
      transitions.push({ evidenceLineId:child.evidenceLineId, action:'root',
        predecessorEvidenceLineId:null, canonicalOriginEvidenceLineId:child.evidenceLineId });
      continue;
    }

    const predecessorId = action.predecessorEvidenceLineId.toLowerCase();
    const parent = previousById.get(predecessorId);
    if (!parent || !parent.canonicalOriginEvidenceLineId || predecessorUse.has(predecessorId)) invalidLineage();
    predecessorUse.add(predecessorId);
    if (child.orderId!==parent.orderId || child.detailId!==parent.detailId || child.stageCode!==parent.stageCode
      || child.evidenceKind!==parent.evidenceKind || child.rework!==parent.rework
      || (action.action==='carry' && child.quantity!==parent.quantity)
      || (action.action==='reduce' && (input.manifest.operation!=='correction' || child.quantity>=parent.quantity))) {
      invalidLineage();
    }
    const key = positionKey(child.orderId,child.detailId,child.rework);
    carriedByPosition.set(key,lineageSum(carriedByPosition.get(key) ?? 0,child.quantity));
    transitions.push({ evidenceLineId:child.evidenceLineId, action:action.action,
      predecessorEvidenceLineId:predecessorId,
      canonicalOriginEvidenceLineId:parent.canonicalOriginEvidenceLineId.toLowerCase() });
  }

  if (previousRows.some(parent => !predecessorUse.has(parent.evidenceLineId.toLowerCase())
      && !dropped.has(parent.evidenceLineId.toLowerCase()))
    || [...dropped].some(id => !previousById.has(id))
    || [...dropped].some(id => predecessorUse.has(id))) invalidLineage();
  if (input.predecessorAcceptedRevisionKey===null && (previousRows.length>0 || dropped.size>0)) invalidLineage();

  for (const [key,rootQuantity] of rootsByPosition) {
    const membership = membershipByPosition.get(key);
    if (membership===undefined || rootQuantity>Math.max(0,membership-(carriedByPosition.get(key) ?? 0))) invalidLineage();
  }
  await tx.query(`INSERT INTO mdf_physical_lineage_contracts
    (source_kind,source_id,revision_key,operation,production_authority,
      predecessor_accepted_revision_key,manifest_digest,dropped_predecessor_evidence_line_ids)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::uuid[])`, [input.sourceKind,input.sourceId,input.revisionKey,
    input.manifest.operation,input.manifest.operation==='production'?input.manifest.authority:null,
    input.predecessorAcceptedRevisionKey,input.manifestDigest,input.manifest.droppedPredecessorEvidenceLineIds]);
  await tx.query(`INSERT INTO mdf_physical_lineage_transitions
    (source_kind,source_id,revision_key,evidence_line_id,action,predecessor_evidence_line_id,
      canonical_origin_evidence_line_id)
    SELECT $1,$2,$3,(entry->>'evidenceLineId')::uuid,entry->>'action',
      NULLIF(entry->>'predecessorEvidenceLineId','')::uuid,(entry->>'canonicalOriginEvidenceLineId')::uuid
    FROM jsonb_array_elements($4::jsonb) entry`, [input.sourceKind,input.sourceId,input.revisionKey,
    JSON.stringify(transitions)]);
}

/** V2 replay compares the durable action rows as well as both immutable
 * digests. This makes the descriptor itself replay authority, not a hash-only
 * assertion that could conceal altered lineage rows. */
export async function verifyMdfPhysicalLineageReplay(tx: DatabaseClient, input: {
  sourceKind:MdfSourceKind; sourceId:string; revisionKey:string; manifest:MdfPhysicalLineageManifest;
}): Promise<boolean> {
  const contract = (await tx.query<{ operation:string; production_authority:string|null;
    dropped_predecessor_evidence_line_ids:string[] }>(`SELECT operation,production_authority,
      dropped_predecessor_evidence_line_ids
    FROM mdf_physical_lineage_contracts WHERE source_kind=$1 AND source_id=$2 AND revision_key=$3`,
  [input.sourceKind,input.sourceId,input.revisionKey])).rows[0];
  if (!contract) return false;
  const rows = (await tx.query<{ line_key:string; action:'root'|'carry'|'reduce';
    predecessor_evidence_line_id:string|null; child_source_kind:string; child_source_id:string; child_revision_key:string }>(`
    SELECT e.line_key,t.action,t.predecessor_evidence_line_id::text predecessor_evidence_line_id,
      e.source_kind child_source_kind,e.source_id child_source_id,e.revision_key child_revision_key
    FROM mdf_physical_lineage_transitions t
    JOIN mdf_evidence_lines e ON e.evidence_line_id=t.evidence_line_id
    WHERE t.source_kind=$1 AND t.source_id=$2 AND t.revision_key=$3
    ORDER BY e.line_key`, [input.sourceKind,input.sourceId,input.revisionKey])).rows;
  if (rows.some(row=>row.child_source_kind!==input.sourceKind || row.child_source_id!==input.sourceId
      || row.child_revision_key!==input.revisionKey)) return false;
  const actions = rows.map<MdfPhysicalLineageAction>(row => {
    if (row.action==='root') return { lineKey:row.line_key,action:'root' };
    if ((row.action==='carry' || row.action==='reduce') && row.predecessor_evidence_line_id) {
      return { lineKey:row.line_key,action:row.action,predecessorEvidenceLineId:row.predecessor_evidence_line_id.toLowerCase() };
    }
    return { lineKey:row.line_key,action:'carry',predecessorEvidenceLineId:'' };
  })
    .sort((a,b)=>a.lineKey < b.lineKey ? -1 : a.lineKey > b.lineKey ? 1 : 0);
  const drops=(contract.dropped_predecessor_evidence_line_ids ?? []).map(id=>id.toLowerCase()).sort();
  if (contract.operation==='production') {
    if (contract.production_authority!=='manual_production' && contract.production_authority!=='cnc_observation') return false;
  } else if (contract.production_authority!==null) return false;
  let stored: MdfPhysicalLineageManifest;
  if (contract.operation==='production') {
    const authority=contract.production_authority;
    if (authority!=='manual_production' && authority!=='cnc_observation') return false;
    if (drops.length!==0) return false;
    stored={ operation:'production',authority,actions,droppedPredecessorEvidenceLineIds:[] };
  } else if (contract.operation==='carry') {
    if (drops.length!==0) return false;
    stored={ operation:'carry',actions,droppedPredecessorEvidenceLineIds:[] };
  } else if (contract.operation==='correction') {
    stored={ operation:'correction',actions,droppedPredecessorEvidenceLineIds:drops };
  } else return false;
  return JSON.stringify(stored)===JSON.stringify(input.manifest);
}

function positionKey(orderId:number,detailId:number,rework:boolean):string {
  return `${orderId}:${detailId}:${rework?'1':'0'}`;
}

function invalidLineage(): never {
  throw new Error('MDF_LINEAGE_INVALID');
}

function lineageSum(left:number,right:number):number {
  try { return mdfSum(left,right); }
  catch { return invalidLineage(); }
}

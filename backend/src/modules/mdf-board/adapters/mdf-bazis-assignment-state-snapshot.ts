import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../../database/database.types';
import { mdfBazisMembershipDigest, issueMdfValidatedBazisAssignmentState,
  type MdfValidatedBazisAssignmentState, type MdfBazisMembershipFact } from '../application/mdf-bazis-assignment-state';
import type { MdfExecutionHead } from './mdf-execution-snapshot';
import { mdfSourceKey } from './mdf-execution-snapshot';

const MAX_REVISIONS=1000, MAX_LINES=50000;
const revisionKey=(head:MdfExecutionHead,revision:string)=>JSON.stringify([head.kind,head.id,revision]);

interface StateRow extends QueryResultRow {
  kind:string; id:string; revision:string; stateId:string|null; rootIntentId:string|null;
  predecessorRevision:string|null; predecessorStateId:string|null; membershipDigest:string|null;
  intentionalEmpty:boolean|null; sealed:boolean; contextFound:boolean; compositionComplete:boolean|null;
  contextPredecessorAccepted:string|null; contextPredecessorReceived:string|null;
  sourceHasState:boolean; rootKind:string|null; rootId:string|null; rootRevision:string|null;
  rootStateId:string|null; rootDigest:string|null; rootEmpty:boolean|null; rootJobStatus:string|null; rootJobId:string|null;
  rootPredecessorRevision:string|null;
  currentIntent:boolean; intentStateId:string|null; intentDigest:string|null; intentEmpty:boolean|null;
  parentStateId:string|null; parentRootIntentId:string|null; parentDigest:string|null; parentEmpty:boolean|null;
  predecessorOfComposition:boolean;
}
interface MemberRow extends QueryResultRow {
  kind:string; id:string; revision:string; lineKey:string; orderId:number; detailId:number;
  quantity:number; rework:boolean; stageCode:string; evidenceKind:string;
}

export interface MdfBazisAssignmentStateSnapshot {
  states: Map<string,MdfValidatedBazisAssignmentState>;
  issues: Map<string,string[]>;
}

/** Loads only accepted/received BASIS revisions. Authority is issued only after
 * immutable marker, root intent/job, predecessor state, seal/context, and exact
 * current membership digest all agree. No raw table or shadow fallback exists. */
export async function loadMdfBazisAssignmentStateSnapshot(tx:DatabaseClient,
  heads:readonly MdfExecutionHead[],options:{allowPendingJobId?:string}={}):Promise<MdfBazisAssignmentStateSnapshot> {
  const wanted=new Map<string,{kind:'bazisCutSet';id:string;revision:string}>();
  for(const head of heads) if(head.kind==='bazisCutSet') for(const revision of [head.accepted,head.received])
    if(revision) wanted.set(JSON.stringify([head.kind,head.id,revision]),{kind:'bazisCutSet',id:head.id,revision});
  if(!wanted.size)return{states:new Map(),issues:new Map()};
  if(wanted.size>MAX_REVISIONS)throw new Error('MDF_ASSIGNMENT_STATE_LIMIT');
  const rows=[...wanted.values()].sort((a,b)=>a.id.localeCompare(b.id)||a.revision.localeCompare(b.revision));
  const kinds=rows.map(r=>r.kind),ids=rows.map(r=>r.id),revisions=rows.map(r=>r.revision);
  const stateRows=(await tx.query<StateRow>(`WITH wanted AS (
      SELECT * FROM unnest($1::text[],$2::text[],$3::text[]) AS w(kind,id,revision)
    )
    SELECT w.kind,w.id,w.revision,s.assignment_state_id::text "stateId",s.root_intent_id::text "rootIntentId",
      s.predecessor_revision_key "predecessorRevision",s.predecessor_state_id::text "predecessorStateId",
      s.membership_digest "membershipDigest",s.intentional_empty "intentionalEmpty",
      (z.revision_key IS NOT NULL) sealed,(ctx.revision_key IS NOT NULL) "contextFound",
      ctx.composition_complete "compositionComplete",ctx.predecessor_accepted_revision_key "contextPredecessorAccepted",
      ctx.predecessor_received_revision_key "contextPredecessorReceived",
      EXISTS(SELECT 1 FROM mdf_bazis_assignment_states any_s WHERE any_s.source_kind=w.kind AND any_s.source_id=w.id) "sourceHasState",
      root.source_kind "rootKind",root.source_id "rootId",root.revision_key "rootRevision",
      root.assignment_state_id::text "rootStateId",root.membership_digest "rootDigest",root.intentional_empty "rootEmpty",
      root.predecessor_revision_key "rootPredecessorRevision",job.status "rootJobStatus",job.job_id::text "rootJobId",
      (intent.intent_id IS NOT NULL) "currentIntent",
      intent.assignment_state_id::text "intentStateId",intent.membership_digest "intentDigest",intent.intentional_empty "intentEmpty",
      parent.assignment_state_id::text "parentStateId",parent.root_intent_id::text "parentRootIntentId",
      parent.membership_digest "parentDigest",parent.intentional_empty "parentEmpty",
      EXISTS(SELECT 1 FROM mdf_bazis_composition_intents i WHERE i.source_kind=w.kind AND i.source_id=w.id
        AND i.predecessor_revision_key=w.revision) "predecessorOfComposition"
    FROM wanted w
    LEFT JOIN mdf_bazis_assignment_states s ON s.source_kind=w.kind AND s.source_id=w.id AND s.revision_key=w.revision
    LEFT JOIN mdf_revision_seals z ON z.source_kind=w.kind AND z.source_id=w.id AND z.revision_key=w.revision
    LEFT JOIN mdf_revision_context ctx ON ctx.source_kind=w.kind AND ctx.source_id=w.id AND ctx.revision_key=w.revision
    LEFT JOIN mdf_bazis_composition_intents intent ON intent.source_kind=w.kind AND intent.source_id=w.id AND intent.revision_key=w.revision
    LEFT JOIN mdf_bazis_composition_intents root ON root.intent_id=s.root_intent_id
    LEFT JOIN mdf_recalculation_jobs job ON job.job_id=root.job_id
    LEFT JOIN mdf_bazis_assignment_states parent ON parent.source_kind=s.source_kind AND parent.source_id=s.source_id
      AND parent.revision_key=s.predecessor_revision_key
    ORDER BY w.id,w.revision`,[kinds,ids,revisions])).rows;
  const memberRows=(await tx.query<MemberRow>(`SELECT l.source_kind kind,l.source_id id,l.revision_key revision,
      l.line_key "lineKey",l.order_id::float8 "orderId",l.detail_id::float8 "detailId",
      l.quantity::float8 quantity,l.rework,l.stage_code "stageCode",l.evidence_kind "evidenceKind"
    FROM unnest($1::text[],$2::text[],$3::text[]) w(kind,id,revision)
    JOIN mdf_evidence_lines l ON l.source_kind=w.kind AND l.source_id=w.id AND l.revision_key=w.revision
      AND l.stage_code='membership' AND l.evidence_kind='derived'
    ORDER BY l.source_kind,l.source_id,l.revision_key,l.line_key LIMIT $4`,[kinds,ids,revisions,MAX_LINES+1])).rows;
  if(memberRows.length>MAX_LINES)throw new Error('MDF_ASSIGNMENT_STATE_LIMIT');
  const members=new Map<string,MemberRow[]>();
  for(const row of memberRows){const k=JSON.stringify([row.kind,row.id,row.revision]);const list=members.get(k)??[];list.push(row);members.set(k,list);}
  const states=new Map<string,MdfValidatedBazisAssignmentState>(),issues=new Map<string,string[]>();
  for(const row of stateRows){
    const k=mdfSourceKey({kind:row.kind,id:row.id}),rk=JSON.stringify([row.kind,row.id,row.revision]);
    if(!row.stateId){if(row.sourceHasState&&!row.predecessorOfComposition)issues.set(k,['MDF_ASSIGNMENT_STATE_REQUIRED']);continue;}
    try{
      const lines=members.get(rk)??[];
      const digest=mdfBazisMembershipDigest(lines);
      const membersEmpty=lines.length===0;
      const valid=row.sealed&&row.contextFound&&row.compositionComplete===true
        &&row.stateId!==null&&row.rootIntentId!==null&&row.membershipDigest===digest
        &&row.intentionalEmpty===membersEmpty&&row.rootKind==='bazisCutSet'&&row.rootId===row.id
        &&row.rootStateId===row.stateId&&row.rootDigest===digest&&row.rootEmpty===membersEmpty
        &&(row.rootJobStatus==='done'||(row.rootJobStatus==='pending'&&row.rootJobId===options.allowPendingJobId))
        &&(row.predecessorRevision===null
          ? row.predecessorStateId===null
          : row.predecessorStateId===row.stateId&&row.parentStateId===row.predecessorStateId
            &&row.parentRootIntentId===row.rootIntentId&&row.parentDigest===digest&&row.parentEmpty===membersEmpty
            &&row.contextPredecessorAccepted===row.predecessorRevision
            &&row.contextPredecessorReceived===row.predecessorRevision)
        &&(!row.currentIntent||(row.intentStateId===row.stateId&&row.intentDigest===digest&&row.intentEmpty===membersEmpty
          &&row.rootRevision===row.revision&&row.rootPredecessorRevision===row.contextPredecessorAccepted
          &&row.contextPredecessorAccepted===row.contextPredecessorReceived));
      if(!valid||!row.stateId||!row.rootIntentId||!row.membershipDigest)throw new Error('MDF_ASSIGNMENT_STATE_INVALID');
      states.set(rk,issueMdfValidatedBazisAssignmentState({sourceKind:'bazisCutSet',sourceId:row.id,
        revisionKey:row.revision,assignmentStateId:row.stateId,rootIntentId:row.rootIntentId,
        membershipDigest:row.membershipDigest,intentionalEmpty:row.intentionalEmpty!}));
    }catch{issues.set(k,['MDF_ASSIGNMENT_STATE_INVALID']);}
  }
  return{states,issues};
}

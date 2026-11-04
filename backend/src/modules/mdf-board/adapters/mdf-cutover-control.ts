/**
 * §5.8 cutover controls (GPT-6 plan R5 APPROVED): the loss check ("engine-only facts since activation"), the audited
 * mode transition matrix and the recovery freeze. Every call runs in ONE transaction that holds the EXCLUSIVE cutover
 * lock (writers take the shared form, try-lock ⇒ in-flight writers finish first, new ones answer 409), so the check,
 * the change and its audit are atomic with respect to every MDF writer.
 */
import type { TransactionClient } from '../../../database/database.types';
import { auditService } from '../../../common/audit/audit.service';
import { MDF_MARK_MODE_CHANGED_SQL } from '../application/mdf-command-boundary';
import { hasMdfUnsupportedProductionRounds } from './mdf-baseline-runner';

export const MDF_RECOVERY_WRITER = 'mdf.recovery';
export class MdfCutoverControlRefused extends Error {
  constructor(readonly code: string, readonly detail?: unknown) { super(code); }
}
export interface MdfCutoverActor { operatorUserId: number; requestId: string }
export type MdfEngineTargetMode = 'legacy' | 'read_only' | 'active';

async function lockExclusive(tx: TransactionClient) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('mdf-engine-cutover',0))");
  await tx.query("SELECT set_config('mdf.command_writer',$1,true)", [MDF_RECOVERY_WRITER]);
}

/** Facts written after the activation handoff that the legacy board cannot show. Conservative: every revision after
 * activation except UNCONFIRMED order-demand carries (their order rows are legacy data too) and baseline items; confirmed
 * corrections and position detachments; plus bath
 * transitions, CNC observation receipts, manual command results, allocation changes. Received-but-unaccepted revisions
 * and pending jobs count. */
export async function loadMdfEngineOnlyFacts(tx: TransactionClient): Promise<{ activatedAt: string | null;
  facts: Record<string, number> }> {
  const run = (await tx.query<{ activated_at: string }>(`SELECT updated_at::text activated_at FROM mdf_baseline_runs
    WHERE status='activated' ORDER BY run_seq DESC LIMIT 1`)).rows[0];
  if (!run) return { activatedAt: null, facts: {} };
  const count = async (sql: string) => Number((await tx.query<{ n: string }>(sql, [run.activated_at])).rows[0].n);
  const exists = async (table: string) => (await tx.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL ok`,
    [table])).rows[0].ok;
  const facts: Record<string, number> = {
    revisions: await count(`SELECT count(*)::text n FROM mdf_evidence_revisions r WHERE r.created_at > $1::timestamptz
      AND NOT EXISTS (SELECT 1 FROM mdf_baseline_run_items i WHERE (i.source_kind,i.source_id,i.revision_key)=(r.source_kind,r.source_id,r.revision_key))
      AND NOT EXISTS (SELECT 1 FROM mdf_order_cascade_intents c WHERE (c.source_kind,c.source_id,c.revision_key)=(r.source_kind,r.source_id,r.revision_key)
        AND NOT c.confirmed)`),
    // Confirmed corrections (reduction/detachment previews the user accepted) are engine-only decisions.
    confirmedCorrections: await count(`SELECT count(*)::text n FROM mdf_order_cascade_intents c WHERE c.confirmed
      AND c.created_at > $1::timestamptz`),
    detachments: await count(`SELECT count(*)::text n FROM mdf_position_detachments d WHERE d.created_at > $1::timestamptz`),
    pendingJobs: await count(`SELECT count(*)::text n FROM mdf_recalculation_jobs j WHERE j.status='pending'
      AND j.created_at > $1::timestamptz`),
    // Allocations between a baseline bath revision and baseline supply are a pure function of the baseline (the worker
    // draining the handoff jobs writes them after activation); legacy derives the same at read time — not a loss.
    allocationChanges: await count(`SELECT count(*)::text n FROM mdf_bath_allocations a WHERE a.updated_at > $1::timestamptz
      AND NOT (EXISTS (SELECT 1 FROM mdf_baseline_run_items i WHERE (i.source_kind,i.source_id,i.revision_key)=('bath',a.bath_id,a.bath_revision))
        AND EXISTS (SELECT 1 FROM mdf_evidence_lines e JOIN mdf_baseline_run_items i ON (i.source_kind,i.source_id,i.revision_key)
          =(e.source_kind,e.source_id,e.revision_key) WHERE e.evidence_line_id=a.evidence_line_id))`),
  };
  for (const [key, table] of [['bathTransitions', 'mdf_bath_transitions'], ['cncObservationReceipts', 'mdf_cnc_observation_receipts'],
    ['manualCommandResults', 'mdf_manual_command_results'], ['correctionCommandResults', 'mdf_correction_command_results']] as const) {
    if (await exists(table)) facts[key] = await count(`SELECT count(*)::text n FROM ${table} WHERE created_at > $1::timestamptz`);
  }
  return { activatedAt: run.activated_at, facts: Object.fromEntries(Object.entries(facts).filter(([, n]) => n > 0)) };
}

export async function changeMdfEngineMode(tx: TransactionClient, actor: MdfCutoverActor, target: MdfEngineTargetMode) {
  if (!['legacy', 'read_only', 'active'].includes(target)) throw new MdfCutoverControlRefused('MDF_MODE_TRANSITION_NOT_ALLOWED');
  await lockExclusive(tx);
  const from = (await tx.query<{ mode: string }>('SELECT mode FROM mdf_engine_state WHERE singleton FOR UPDATE')).rows[0]?.mode;
  if (!from) throw new MdfCutoverControlRefused('MDF_ENGINE_STATE_UNAVAILABLE');
  const guard = (await tx.query<{ freeze_run_id: string | null }>('SELECT freeze_run_id FROM mdf_freeze_guard WHERE singleton')).rows[0];
  if (guard?.freeze_run_id) throw new MdfCutoverControlRefused('MDF_BASELINE_RUN_UNFINISHED');
  const activated = (await tx.query<{ n: string }>(`SELECT count(*)::text n FROM mdf_baseline_runs WHERE status='activated'`)).rows[0].n !== '0';
  if (from === target) return { from, to: target, changed: false };
  let facts: Record<string, number> = {};
  // Explicit matrix. Engine modes (active/read_only) are entered ONLY through the baseline handoff: never from
  // legacy or shadow here; after a legacy fallback the engine is stale for its epoch (re-baseline unsupported).
  const engine = (m: string) => m === 'active' || m === 'read_only';
  if (engine(target) && !engine(from)) {
    throw new MdfCutoverControlRefused(activated ? 'MDF_REACTIVATION_REQUIRES_REBASELINE' : 'MDF_ACTIVATION_ONLY_VIA_HANDOFF');
  }
  if (engine(target) && !activated) throw new MdfCutoverControlRefused('MDF_ACTIVATION_PROVENANCE_MISSING');
  // No engine model for rework rounds yet: never (re)enter `active` while a live detail is in round > 1.
  if (target === 'active' && await hasMdfUnsupportedProductionRounds(tx)) {
    throw new MdfCutoverControlRefused('MDF_PRODUCTION_ROUNDS_UNSUPPORTED');
  }
  if (target === 'legacy' && engine(from)) {
    // Fail closed: an engine mode without an activated run has no loss-check provenance.
    if (!activated) throw new MdfCutoverControlRefused('MDF_ACTIVATION_PROVENANCE_MISSING');
    const loss = await loadMdfEngineOnlyFacts(tx);
    facts = loss.facts;
    if (Object.keys(facts).length) throw new MdfCutoverControlRefused('MDF_ROLLBACK_WOULD_LOSE_FACTS', loss);
  } else if (target === 'legacy' && from !== 'shadow') {
    throw new MdfCutoverControlRefused('MDF_MODE_TRANSITION_NOT_ALLOWED');
  }
  await tx.query('UPDATE mdf_engine_state SET mode=$1,updated_at=now() WHERE singleton', [target]);
  await tx.query(MDF_MARK_MODE_CHANGED_SQL);
  const auditId = await auditService.record(tx, { event: 'mdf.engine.mode_changed', entityType: 'mdf_engine', entityId: 'mode',
    actorUserId: actor.operatorUserId, requestId: actor.requestId, source: 'backend-mdf-cutover-control',
    before: { mode: from }, after: { mode: target }, metadata: { lossCheck: target === 'legacy' ? facts : null } });
  if (!auditId) throw new Error('MDF_CUTOVER_AUDIT_FAILED');
  return { from, to: target, changed: true };
}

export async function setMdfRecoveryFreeze(tx: TransactionClient, actor: MdfCutoverActor, on: boolean, reason?: string) {
  await lockExclusive(tx);
  const current = (await tx.query<{ recovery: string | null }>(
    "SELECT recovery_frozen_at::text recovery FROM mdf_freeze_guard WHERE singleton FOR UPDATE")).rows[0];
  if (!current) throw new MdfCutoverControlRefused('MDF_ENGINE_STATE_UNAVAILABLE');
  if ((current.recovery !== null) === on) return { changed: false };
  if (on && (!reason || !reason.trim())) throw new MdfCutoverControlRefused('MDF_RECOVERY_REASON_REQUIRED');
  await tx.query(on ? "UPDATE mdf_freeze_guard SET recovery_frozen_at=now(),recovery_reason=$1 WHERE singleton"
    : "UPDATE mdf_freeze_guard SET recovery_frozen_at=NULL,recovery_reason=NULL WHERE singleton", on ? [reason!.trim()] : []);
  const auditId = await auditService.record(tx, { event: on ? 'mdf.engine.recovery_frozen' : 'mdf.engine.recovery_unfrozen',
    entityType: 'mdf_engine', entityId: 'recovery_freeze', actorUserId: actor.operatorUserId, requestId: actor.requestId,
    source: 'backend-mdf-cutover-control', before: { frozen: !on }, after: { frozen: on, reason: on ? reason!.trim() : null } });
  if (!auditId) throw new Error('MDF_CUTOVER_AUDIT_FAILED');
  return { changed: true };
}

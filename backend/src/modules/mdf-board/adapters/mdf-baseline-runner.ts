/**
 * §5.7b initial population (baseline) runner. Plan: spec_erp/plans/mdf-baseline-population-impl-2026-09-27.md
 * (GPT-6 R7/R8/R8b). Lifecycle: started → recorded → activated | started/recorded → aborted | recorded → drifted |
 * aborted/drifted → reset. While a run is unfinished the engine is durably frozen (`mdf_freeze_guard`): only this
 * runner (`mdf.command_writer = mdf.baseline`) writes. Apply holds the exclusive cutover lock on ONE dedicated session
 * for the whole run; the dry-run does everything in one READ COMMITTED transaction and always rolls back.
 */
import { randomUUID } from 'node:crypto';
import type { TransactionClient } from '../../../database/database.types';
import { auditService } from '../../../common/audit/audit.service';
import { MDF_BASELINE_WRITER, MDF_MARK_MODE_CHANGED_SQL, enterMdfCommand, discardMdfCommandBoundary } from '../application/mdf-command-boundary';
import { recordMdfBaselineReceipt } from '../application/mdf-receipt';
import { MdfJobRunner } from '../application/mdf-job-runner';
import { executeMdfAcceptedJob } from '../application/mdf-accepted-job';
import { buildMdfBaselineItems, expectMdfBaseline, MDF_BASELINE_ALGORITHM, type MdfBaselineBuild,
  type MdfBaselineItem } from '../domain/mdf-baseline';
import { classifyMdfReconciliationSource } from '../domain/mdf-reconciliation';
import { loadMdfReconciliationInventory } from './mdf-reconciliation-inventory';
import { mdfPositionKey } from '../domain/mdf-quantities';

const LOCK = "hashtextextended('mdf-engine-cutover',0)";
const BATCH = 100;
export class MdfBaselineRefused extends Error {
  constructor(readonly code: string, readonly detail?: unknown) { super(code); }
}
export interface MdfBaselineActor { operatorUserId: number | null; requestId: string }

async function tagWriter(tx: TransactionClient) {
  await tx.query("SELECT set_config('mdf.command_writer',$1,true)", [MDF_BASELINE_WRITER]);
}

/** The inventory is read only AFTER the exclusive lock / freeze, on the caller's transaction. */
export async function loadMdfBaselineBuild(tx: TransactionClient): Promise<MdfBaselineBuild> {
  const inventory = await loadMdfReconciliationInventory(tx);
  const sources = inventory.inputs.map(classifyMdfReconciliationSource);
  return buildMdfBaselineItems({ sources, demand: inventory.demand, orders: new Map([...inventory.orders].map(([id, o]) =>
    [id, { id, name: o.name, readyOrLater: o.readyOrLater, deleted: o.deleted, kind: o.kind, createdAt: o.createdAt }])) });
}

/** FRESH admission (R2/R3/R8): no accepted authority; only diagnostic shadow rows may pre-exist. */
export async function assertMdfBaselineFresh(tx: TransactionClient): Promise<void> {
  const row = (await tx.query<Record<string, boolean | string>>(`SELECT
    EXISTS(SELECT 1 FROM mdf_source_heads WHERE accepted_revision_key IS NOT NULL) accepted_heads,
    EXISTS(SELECT 1 FROM mdf_bath_allocations) allocations,
    EXISTS(SELECT 1 FROM mdf_published_sources) OR EXISTS(SELECT 1 FROM mdf_published_positions)
      OR EXISTS(SELECT 1 FROM mdf_published_source_members) published,
    EXISTS(SELECT 1 FROM mdf_position_detachments) OR EXISTS(SELECT 1 FROM mdf_physical_lineage_contracts)
      OR EXISTS(SELECT 1 FROM mdf_bath_transitions) OR EXISTS(SELECT 1 FROM mdf_order_cascade_intents)
      OR EXISTS(SELECT 1 FROM mdf_bazis_composition_intents) other_authority,
    (SELECT published_revision FROM mdf_engine_state WHERE singleton)<>0 published_revision,
    EXISTS(SELECT 1 FROM mdf_recalculation_jobs WHERE NOT (status='needs_attention' AND error_code='MDF_ACCEPTANCE_REQUIRED')) jobs,
    EXISTS(SELECT 1 FROM mdf_revision_context) contexts,
    EXISTS(SELECT 1 FROM mdf_baseline_runs WHERE status IN ('started','recorded','drifted','aborted')) unfinished_run,
    EXISTS(SELECT 1 FROM mdf_baseline_runs WHERE status='activated') activated_run,
    (SELECT mode FROM mdf_engine_state WHERE singleton) mode`)).rows[0];
  const failed = Object.entries(row).filter(([k, v]) => k !== 'mode' && v === true).map(([k]) => k);
  if (row.mode !== 'legacy' && row.mode !== 'shadow') failed.push(`mode:${String(row.mode)}`);
  if (failed.length) throw new MdfBaselineRefused('MDF_BASELINE_NOT_FRESH', failed);
}

async function audit(tx: TransactionClient, actor: MdfBaselineActor, event: string, runId: string,
  extra: { before?: Record<string, unknown>; after?: Record<string, unknown>; metadata?: Record<string, unknown>;
    orderIds?: number[]; entityType?: string; entityId?: string } = {}) {
  const orderIds = [...new Set(extra.orderIds ?? [])].sort((a, b) => a - b);
  const id = await auditService.record(tx, { event, entityType: extra.entityType ?? 'mdf_baseline_run',
    entityId: extra.entityId ?? runId, actorUserId: actor.operatorUserId, requestId: actor.requestId,
    source: 'backend-mdf-baseline', relatedOrderId: orderIds.length === 1 ? orderIds[0] : null,
    before: extra.before ?? null, after: extra.after ?? null,
    metadata: { runId, algorithm: MDF_BASELINE_ALGORITHM, notificationEventDecision: 'baseline_publish_only_no_effects',
      ...(extra.metadata ?? {}) },
    relatedEntities: orderIds.map(entityId => ({ entityType: 'order' as const, entityId })) });
  if (!id) throw new Error('MDF_BASELINE_AUDIT_FAILED');
}

async function setMode(tx: TransactionClient, actor: MdfBaselineActor, runId: string, to: 'read_only' | 'active' | 'legacy') {
  const from = (await tx.query<{ mode: string }>('SELECT mode FROM mdf_engine_state WHERE singleton FOR UPDATE')).rows[0]?.mode;
  if (from === to) return;
  await tx.query('UPDATE mdf_engine_state SET mode=$1,updated_at=now() WHERE singleton', [to]);
  await tx.query(MDF_MARK_MODE_CHANGED_SQL);
  await audit(tx, actor, 'mdf.engine.mode_changed', runId, { entityType: 'mdf_engine', entityId: 'mode',
    before: { mode: from }, after: { mode: to } });
}

/** Start: caller already holds the exclusive cutover lock (session for apply, xact for dry-run). */
export async function startMdfBaselineRun(tx: TransactionClient, actor: MdfBaselineActor,
  manifest: Record<string, unknown>): Promise<{ runId: string; runSeq: string; build: MdfBaselineBuild }> {
  await tagWriter(tx);
  await assertMdfBaselineFresh(tx);
  const build = await loadMdfBaselineBuild(tx);
  const runId = randomUUID();
  const runSeq = (await tx.query<{ run_seq: string }>(`INSERT INTO mdf_baseline_runs(run_id,status,operator_user_id,request_id,manifest)
    VALUES($1,'started',$2,$3,$4::jsonb) RETURNING run_seq::text`, [runId, actor.operatorUserId, actor.requestId,
    JSON.stringify({ ...manifest, algorithm: MDF_BASELINE_ALGORITHM, itemCount: build.items.length, itemsDigest: build.itemsDigest,
      skipped: build.skipped, closedOrderCount: build.closedOrderIds.length, manualReviewOrderIds: build.manualReviewOrderIds })])).rows[0].run_seq;
  // R8: snapshot every pre-existing (diagnostic) engine row.
  await tx.query(`INSERT INTO mdf_baseline_run_preexisting(run_id,row_kind,row_key,snapshot)
    SELECT $1::uuid,'head',source_kind||':'||source_id,jsonb_build_object('received',received_revision_key,
      'accepted',accepted_revision_key,'version',version::text,'correctionEpoch',correction_epoch::text,'updatedAt',updated_at)
    FROM mdf_source_heads
    UNION ALL SELECT $1::uuid,'revision',source_kind||':'||source_id||':'||revision_key,jsonb_build_object('origin',origin)
    FROM mdf_evidence_revisions
    UNION ALL SELECT $1::uuid,'job',job_id::text,jsonb_build_object('status',status,'errorCode',error_code)
    FROM mdf_recalculation_jobs`, [runId]);
  await tx.query('UPDATE mdf_freeze_guard SET freeze_run_id=$1 WHERE singleton', [runId]);
  await audit(tx, actor, 'mdf.baseline.run_started', runId, { after: { status: 'started', itemCount: build.items.length,
    itemsDigest: build.itemsDigest, skipped: build.skipped.length, closedOrders: build.closedOrderIds.length,
    manualReview: build.manualReviewOrderIds.length } });
  await setMode(tx, actor, runId, 'read_only');
  return { runId, runSeq, build };
}

/** One batch = one transaction on the apply session: run item + receipt + audit per item (R2#4). */
export async function recordMdfBaselineBatch(tx: TransactionClient, actor: MdfBaselineActor, runId: string, runSeq: string,
  items: readonly MdfBaselineItem[]): Promise<number> {
  await tagWriter(tx);
  discardMdfCommandBoundary(tx);
  await enterMdfCommand(tx, { writer: MDF_BASELINE_WRITER, capability: 'baseline' });
  const done = new Set((await tx.query<{ item_key: string }>('SELECT item_key FROM mdf_baseline_run_items WHERE run_id=$1',
    [runId])).rows.map(r => r.item_key));
  let recorded = 0;
  for (const item of items) {
    if (done.has(item.itemKey)) continue;
    const revisionKey = `baseline:v1:${runSeq}:${item.digest}`;
    await tx.query(`INSERT INTO mdf_baseline_run_items(run_id,item_key,item_kind,source_kind,source_id,revision_key,item_digest)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [runId, item.itemKey, item.itemKind, item.sourceKind, item.sourceId, revisionKey, item.digest]);
    const head = (await tx.query<{ version: string; epoch: string }>(`SELECT version::text version,correction_epoch::text epoch
      FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2`, [item.sourceKind, item.sourceId])).rows[0];
    const saved = await recordMdfBaselineReceipt(tx, { sourceKind: item.sourceKind, sourceId: item.sourceId, revisionKey,
      actorUserId: actor.operatorUserId, requestId: actor.requestId, causeKey: `mdf-baseline:${runId}:${item.itemKey}`,
      expectedFence: head ? { version: head.version, correctionEpoch: head.epoch } : null, sourceDigest: item.digest,
      executionContext: { ...item.context, demand: item.context.demand.map(d => ({ ...d })) },
      lines: item.lines.map(l => ({ ...l })),
      ...(item.sourceKind === 'order' ? {} : { presentation: 'compute' as const }) },
    { runId, closure: item.itemKind === 'order_closure' ? 'by_status' : null });
    if (!saved.accepted || saved.replay) throw new MdfBaselineRefused('MDF_BASELINE_RECEIPT_REJECTED', item.itemKey);
    await audit(tx, actor, item.itemKind === 'order_closure' ? 'mdf.baseline.order_closed' : 'mdf.baseline.source_recorded',
      runId, { entityType: item.sourceKind === 'order' ? 'order' : 'mdf_board_card',
        entityId: item.sourceKind === 'order' ? item.sourceId : `${item.sourceKind}:${item.sourceId}`,
        orderIds: item.orderIds, after: { revisionKey, digest: item.digest, lines: item.lines.length },
        metadata: { provenance: item.provenance, jobId: saved.jobId } });
    recorded += 1;
  }
  return recorded;
}

export async function markMdfBaselineRecorded(tx: TransactionClient, actor: MdfBaselineActor, runId: string, build: MdfBaselineBuild) {
  await tagWriter(tx);
  const missing = (await tx.query<{ n: string }>(`SELECT count(*)::text n FROM unnest($2::text[]) k(item_key)
    WHERE NOT EXISTS(SELECT 1 FROM mdf_baseline_run_items i WHERE i.run_id=$1 AND i.item_key=k.item_key)`,
  [runId, build.items.map(i => i.itemKey)])).rows[0].n;
  if (missing !== '0') throw new MdfBaselineRefused('MDF_BASELINE_ITEMS_MISSING', Number(missing));
  await tx.query(`UPDATE mdf_baseline_runs SET status='recorded',item_count=$2,items_digest=$3 WHERE run_id=$1 AND status='started'`,
    [runId, build.items.length, build.itemsDigest]);
  await audit(tx, actor, 'mdf.baseline.run_recorded', runId, { before: { status: 'started' },
    after: { status: 'recorded', itemCount: build.items.length, itemsDigest: build.itemsDigest } });
}

/** Atomic handoff (R2): recompute the complete item set from the live snapshot; equal ⇒ activated + mode active +
 * freeze cleared; different ⇒ drifted (reset required). */
export async function handoffMdfBaseline(tx: TransactionClient, actor: MdfBaselineActor, runId: string):
  Promise<{ status: 'activated' | 'drifted'; drift: string[] }> {
  await tagWriter(tx);
  const run = (await tx.query<{ status: string; items_digest: string }>(
    'SELECT status,items_digest FROM mdf_baseline_runs WHERE run_id=$1 FOR UPDATE', [runId])).rows[0];
  if (run?.status !== 'recorded') throw new MdfBaselineRefused('MDF_BASELINE_NOT_RECORDED', run?.status ?? null);
  const recordedItems = new Map((await tx.query<{ item_key: string; item_digest: string }>(
    'SELECT item_key,item_digest FROM mdf_baseline_run_items WHERE run_id=$1', [runId])).rows.map(r => [r.item_key, r.item_digest]));
  const live = await loadMdfBaselineBuild(tx);
  const drift: string[] = [];
  for (const i of live.items) if (recordedItems.get(i.itemKey) !== i.digest) drift.push(recordedItems.has(i.itemKey) ? `changed:${i.itemKey}` : `added:${i.itemKey}`);
  const liveKeys = new Set(live.items.map(i => i.itemKey));
  for (const k of recordedItems.keys()) if (!liveKeys.has(k)) drift.push(`removed:${k}`);
  if (drift.length) {
    await tx.query(`UPDATE mdf_baseline_runs SET status='drifted' WHERE run_id=$1`, [runId]);
    await audit(tx, actor, 'mdf.baseline.run_drifted', runId, { before: { status: 'recorded' }, after: { status: 'drifted' },
      metadata: { drift: drift.slice(0, 200), driftCount: drift.length } });
    return { status: 'drifted', drift };
  }
  await tx.query(`UPDATE mdf_baseline_runs SET status='activated' WHERE run_id=$1`, [runId]);
  await tx.query('UPDATE mdf_freeze_guard SET freeze_run_id=NULL WHERE singleton');
  await audit(tx, actor, 'mdf.baseline.run_activated', runId, { before: { status: 'recorded' }, after: { status: 'activated' } });
  await setMode(tx, actor, runId, 'active');
  return { status: 'activated', drift };
}

export async function abortMdfBaseline(tx: TransactionClient, actor: MdfBaselineActor, runId: string) {
  await tagWriter(tx);
  const run = (await tx.query<{ status: string }>('SELECT status FROM mdf_baseline_runs WHERE run_id=$1 FOR UPDATE', [runId])).rows[0];
  if (run?.status !== 'started' && run?.status !== 'recorded') throw new MdfBaselineRefused('MDF_BASELINE_NOT_ABORTABLE', run?.status ?? null);
  await tx.query(`UPDATE mdf_baseline_runs SET status='aborted' WHERE run_id=$1`, [runId]);
  await audit(tx, actor, 'mdf.baseline.run_aborted', runId, { before: { status: run.status }, after: { status: 'aborted' } });
}

export async function resetMdfBaseline(tx: TransactionClient, actor: MdfBaselineActor, runId: string) {
  await tagWriter(tx);
  await tx.query('SELECT mdf_reset_unactivated_baseline($1::uuid)', [runId]);
  await audit(tx, actor, 'mdf.baseline.reset', runId, { before: { status: 'aborted|drifted' }, after: { status: 'reset', mode: 'legacy' } });
}

export interface MdfBaselineDryRunReport {
  build: { items: number; skipped: MdfBaselineBuild['skipped']; closedOrders: number; manualReviewOrderIds: number[];
    provenance: Record<string, number> };
  jobs: Record<string, number>; needsAttention: { jobId: string; source: string; code: string | null }[];
  mismatches: { orderId: number; detailId: number; expected: unknown; published: unknown }[];
  statusesUnchanged: boolean; outboxDelta: number; automationDelta: number; published: { sources: number; positions: number };
  /** Issue codes on published baseline cards (expected none). */
  cardIssues: Record<string, number>; columns: Record<string, number>;
  /** Completeness: run-owned jobs not done, source items without a published card, expected positions not published. */
  unfinishedJobs: number; missingCards: string[]; missingPositions: number;
  /** The single gate: activated, every run job done, complete publication, no mismatch/issue/effect/status change. */
  passed: boolean; failures: string[];
  handoff: string; durationMs: number;
}

/** Dry-run (R1#6): ONE READ COMMITTED transaction, always rolled back. The caller passes a fresh transaction. */
export async function dryRunMdfBaseline(tx: TransactionClient, actor: MdfBaselineActor): Promise<MdfBaselineDryRunReport> {
  const started = Date.now();
  if ((await tx.query<{ locked: boolean }>(`SELECT pg_try_advisory_xact_lock(${LOCK}) locked`)).rows[0]?.locked !== true) {
    throw new MdfBaselineRefused('MDF_CUTOVER_IN_PROGRESS');
  }
  const statusesBefore = (await tx.query<{ s: string }>(`SELECT md5(string_agg(order_id||':'||COALESCE(order_status_id::text,'')||':'||
    COALESCE(production_status_id::text,''),',' ORDER BY order_id)) s FROM orders`)).rows[0].s;
  const detailStatusesBefore = (await tx.query<{ s: string }>(`SELECT md5(string_agg(detail_id||':'||COALESCE(production_status_id::text,''),','
    ORDER BY detail_id)) s FROM order_details`)).rows[0].s;
  const outboxBefore = Number((await tx.query<{ n: string }>('SELECT count(*)::text n FROM outbox_events')).rows[0].n);
  const automationBefore = Number((await tx.query<{ n: string }>(
    "SELECT count(*)::text n FROM audit_log WHERE event LIKE 'status_automation.%'")).rows[0].n);
  const { runId, runSeq, build } = await startMdfBaselineRun(tx, actor, { dryRun: true });
  for (let i = 0; i < build.items.length; i += BATCH) await recordMdfBaselineBatch(tx, actor, runId, runSeq, build.items.slice(i, i + BATCH));
  await markMdfBaselineRecorded(tx, actor, runId, build);
  const handoff = await handoffMdfBaseline(tx, actor, runId);
  const jobs: Record<string, number> = {};
  if (handoff.status === 'activated') {
    // Drain through the SAME transaction: the runner's "transaction" is this one (its savepoints nest inside it).
    discardMdfCommandBoundary(tx);
    const runner = new MdfJobRunner<TransactionClient>({ transaction: handler => handler(tx) }, executeMdfAcceptedJob);
    for (let guard = 0; guard < build.items.length * 4 + 10; guard++) {
      const r = await runner.processOne();
      if (r.status === 'idle') {
        // Delayed retries: bring due time forward (bounded by the loop guard).
        const moved = (await tx.query(`UPDATE mdf_recalculation_jobs SET next_attempt_at=transaction_timestamp()
          WHERE status='pending' AND next_attempt_at>transaction_timestamp()`)).rowCount ?? 0;
        if (!moved) break;
        continue;
      }
      jobs[r.status] = (jobs[r.status] ?? 0) + 1;
    }
  }
  const needsAttention = (await tx.query<{ jobId: string; source: string; code: string | null }>(`SELECT job_id::text "jobId",
    source_kind||':'||source_id source,error_code code FROM mdf_recalculation_jobs j
    WHERE status='needs_attention' AND EXISTS(SELECT 1 FROM mdf_baseline_run_items i WHERE i.run_id=$1
      AND i.source_kind=j.source_kind AND i.source_id=j.source_id AND i.revision_key=j.revision_key)`, [runId])).rows;
  const published = (await tx.query<{ orderId: number; detailId: number; creditedCut: number; creditedRolled: number; remaining: number }>(
    `SELECT order_id::float8 "orderId",detail_id::float8 "detailId",credited_cut::float8 "creditedCut",
      credited_rolled::float8 "creditedRolled",remaining::float8 remaining FROM mdf_published_positions`)).rows;
  const publishedSources = Number((await tx.query<{ n: string }>('SELECT count(*)::text n FROM mdf_published_sources')).rows[0].n);
  const cardIssues: Record<string, number> = {}, columns: Record<string, number> = {};
  for (const r of (await tx.query<{ code: string; n: string }>(`SELECT unnest(issues) code,count(*)::text n
    FROM mdf_published_sources GROUP BY 1`)).rows) cardIssues[r.code] = Number(r.n);
  for (const r of (await tx.query<{ col: string | null; n: string }>(`SELECT column_key col,count(*)::text n
    FROM mdf_published_sources GROUP BY 1`)).rows) columns[r.col ?? 'none'] = Number(r.n);
  const unfinishedJobs = Number((await tx.query<{ n: string }>(`SELECT count(*)::text n FROM mdf_recalculation_jobs j
    WHERE status<>'done' AND EXISTS(SELECT 1 FROM mdf_baseline_run_items i WHERE i.run_id=$1
      AND i.source_kind=j.source_kind AND i.source_id=j.source_id AND i.revision_key=j.revision_key)`, [runId])).rows[0].n);
  const publishedKeys = new Set((await tx.query<{ k: string }>(
    "SELECT source_kind||':'||source_id k FROM mdf_published_sources")).rows.map(r => r.k));
  const missingCards = build.items.filter(i => i.itemKind === 'source' && !publishedKeys.has(i.itemKey)).map(i => i.itemKey);
  const inventoryDemand = build.items.flatMap(i => i.context.demand);
  const uniqueDemand = [...new Map(inventoryDemand.map(d => [mdfPositionKey(d), d])).values()];
  const expected = expectMdfBaseline(build, uniqueDemand);
  const publishedByKey = new Map(published.map(p => [mdfPositionKey(p), p]));
  const mismatches: MdfBaselineDryRunReport['mismatches'] = [];
  for (const e of expected) {
    const p = publishedByKey.get(mdfPositionKey(e));
    if (!p || p.creditedCut !== e.creditedCut || p.creditedRolled !== e.creditedRolled || p.remaining !== e.remaining) {
      mismatches.push({ orderId: e.orderId, detailId: e.detailId,
        expected: { creditedCut: e.creditedCut, creditedRolled: e.creditedRolled, remaining: e.remaining },
        published: p ? { creditedCut: p.creditedCut, creditedRolled: p.creditedRolled, remaining: p.remaining } : null });
    }
  }
  const statusesAfter = (await tx.query<{ s: string }>(`SELECT md5(string_agg(order_id||':'||COALESCE(order_status_id::text,'')||':'||
    COALESCE(production_status_id::text,''),',' ORDER BY order_id)) s FROM orders`)).rows[0].s;
  const detailStatusesAfter = (await tx.query<{ s: string }>(`SELECT md5(string_agg(detail_id||':'||COALESCE(production_status_id::text,''),','
    ORDER BY detail_id)) s FROM order_details`)).rows[0].s;
  const outboxAfter = Number((await tx.query<{ n: string }>('SELECT count(*)::text n FROM outbox_events')).rows[0].n);
  const automationAfter = Number((await tx.query<{ n: string }>(
    "SELECT count(*)::text n FROM audit_log WHERE event LIKE 'status_automation.%'")).rows[0].n);
  const missingPositions = expected.filter(e => !publishedByKey.has(mdfPositionKey(e))).length;
  const statusesUnchanged = statusesBefore === statusesAfter && detailStatusesBefore === detailStatusesAfter;
  const failures = [
    ...(handoff.status !== 'activated' ? ['handoff'] : []), ...(needsAttention.length ? ['needs_attention'] : []),
    ...(unfinishedJobs ? ['unfinished_jobs'] : []), ...(missingCards.length ? ['missing_cards'] : []),
    ...(missingPositions ? ['missing_positions'] : []), ...(mismatches.length ? ['quantity_mismatch'] : []),
    ...(Object.keys(cardIssues).length ? ['card_issues'] : []), ...(!statusesUnchanged ? ['statuses_changed'] : []),
    ...(outboxAfter !== outboxBefore ? ['outbox'] : []), ...(automationAfter !== automationBefore ? ['automation'] : [])];
  const provenance: Record<string, number> = {};
  for (const i of build.items) for (const [k, v] of Object.entries(i.provenance)) provenance[k] = (provenance[k] ?? 0) + (v ?? 0);
  return { build: { items: build.items.length, skipped: build.skipped, closedOrders: build.closedOrderIds.length,
    manualReviewOrderIds: build.manualReviewOrderIds, provenance },
  jobs, needsAttention, mismatches, statusesUnchanged, unfinishedJobs, missingCards, missingPositions,
  passed: failures.length === 0, failures,
  outboxDelta: outboxAfter - outboxBefore, automationDelta: automationAfter - automationBefore,
  published: { sources: publishedSources, positions: published.length }, cardIssues, columns, handoff: handoff.status,
  durationMs: Date.now() - started };
}

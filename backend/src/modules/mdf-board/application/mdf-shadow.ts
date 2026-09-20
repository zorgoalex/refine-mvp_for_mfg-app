import { createHash } from 'node:crypto';
import type { TransactionClient } from '../../../database/database.types';
import { beforeTransactionCommit } from '../../../database/transaction-hooks';
import type { MdfBoardEventInput, MdfBoardSource } from '../../status-automation/application/mdf-board-event.types';
import { loadMdfShadowSource, type MdfShadowRow } from '../adapters/mdf-shadow-source';
import { calculateMdfQuantities, mdfSum, type MdfPositionQuantity, type MdfQuantityEvidence } from '../domain/mdf-quantities';
import { recordMdfReceipt, type MdfReceiptLine } from './mdf-receipt';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pending = new WeakMap<TransactionClient, Map<string, MdfBoardEventInput>>();

/** Candidate calculation ONLY. It is never accepted production evidence. */
export function prepareMdfShadow(rows: readonly MdfShadowRow[]) {
  const issues = new Set<string>(['SHADOW_ONLY', 'INCOMPLETE_PRODUCER_COVERAGE']);
  if (!rows.length) issues.add('SOURCE_MISSING');
  const lines: MdfReceiptLine[] = [];
  const demand = new Map<string, MdfPositionQuantity>();
  const evidence: MdfQuantityEvidence[] = [];
  for (const row of rows) {
    if (row.whole_order) issues.add('WHOLE_ORDER_DECLARATION_NOT_FROZEN');
    if (row.unresolved) issues.add('UNRESOLVED_MEMBERSHIP');
    if (!row.relevant) { issues.add('MATERIAL_OR_SOURCE_EXCLUDED'); continue; }
    const orderId = Number(row.order_id), detailId = Number(row.detail_id), quantity = Number(row.quantity);
    if (row.unresolved || !row.line_key || ![orderId, detailId, quantity].every(n => Number.isSafeInteger(n) && n > 0)) {
      issues.add('UNRESOLVED_MEMBERSHIP'); continue;
    }
    const key = `${orderId}:${detailId}`, lineKey = digest(row.line_key);
    const position = demand.get(key) ?? { orderId, detailId, quantity: 0 };
    position.quantity = mdfSum(position.quantity, quantity);
    demand.set(key, position);
    lines.push({ lineKey: `member:${lineKey}`, orderId, detailId, quantity,
      stageCode: 'membership', evidenceKind: 'derived', rework: row.rework });
    for (const stage of ['cut', 'laminated'] as const) if (row[stage]) {
      lines.push({ lineKey: `${stage}:${lineKey}`, orderId, detailId, quantity,
        stageCode: stage, evidenceKind: 'physical', rework: row.rework });
      evidence.push({ orderId, detailId, quantity, source: 'candidate', line: `${stage}:${lineKey}`,
        stage, kind: 'physical', rework: row.rework });
    }
  }
  return { sourceDigest: digest(rows), lines, issues: [...issues].sort(),
    // This demand is the source's own membership, NOT full order demand.
    candidateQuantities: calculateMdfQuantities({ demand: [...demand.values()], evidence }) };
}

/** No SQL/domain locks at registration. One sorted finalizer runs after all
 * legacy command writes, before COMMIT. Feature disabled => zero work. It is
 * intentionally independent of automation/notification enable flags. */
export function markMdfShadowSource(tx: TransactionClient, input: MdfBoardEventInput): void {
  if (process.env.BACKEND_MDF_SHADOW_INTAKE !== 'true') return;
  let sources = pending.get(tx);
  if (!sources) {
    sources = new Map();
    pending.set(tx, sources);
    const captured = sources;
    beforeTransactionCommit(tx, 'mdf-shadow-intake', async () => {
      try { await captureMdfShadow(tx, [...captured.values()]); }
      finally { pending.delete(tx); }
    });
  }
  sources.set(JSON.stringify([input.source.kind, input.source.id]), {
    ...input, source: { ...input.source }, actor: { ...input.actor },
  });
}

async function captureMdfShadow(tx: TransactionClient, inputs: readonly MdfBoardEventInput[]): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover',0))");
  const mode = (await tx.query<{ mode: string }>('SELECT mode FROM mdf_engine_state WHERE singleton')).rows[0]?.mode;
  if (mode !== 'legacy' && mode !== 'shadow') throw new Error('MDF_SHADOW_MODE_CONFLICT');
  const rules = (await tx.query<{ id: string; version: number }>(`SELECT id,version FROM status_automation_rules
    WHERE is_enabled AND event_type LIKE 'mdf.%' ORDER BY id`)).rows.map(r => ({ ruleId: Number(r.id), version: Number(r.version) }));
  // Load ALL source snapshots before source-head locks; then acquire sources in
  // deterministic order. No calls back into order/status automation from here.
  const sorted = [...inputs].sort((a, b) => sourceKey(a.source) < sourceKey(b.source) ? -1 : 1);
  const snapshots = [];
  for (const input of sorted) snapshots.push({ input, prepared: prepareMdfShadow(await loadMdfShadowSource(tx, input.source)) });
  for (const { input, prepared } of snapshots) {
    const source = [input.source.kind, input.source.id];
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mdf-source:${JSON.stringify(source)}`]);
    const head = (await tx.query<{ version: string; correction_epoch: string }>(`SELECT version,correction_epoch
      FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2 FOR UPDATE`, source)).rows[0];
    const revisionKey = `shadow:${digest(input.sourceIdempotencyKey)}`;
    await recordMdfReceipt(tx, {
      sourceKind: input.source.kind, sourceId: input.source.id, revisionKey, origin: 'legacy',
      actorUserId: Number(input.actor.id), requestId: input.requestId, causeKey: input.sourceIdempotencyKey,
      expectedFence: head ? { version: head.version, correctionEpoch: head.correction_epoch } : null,
      sourceDigest: prepared.sourceDigest, accept: false, lines: prepared.lines, rules,
    });
    await tx.query(`INSERT INTO mdf_shadow_observations
      (source_kind,source_id,revision_key,source_digest,issues,candidate_quantities)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
    [...source, revisionKey, prepared.sourceDigest, prepared.issues, JSON.stringify(prepared.candidateQuantities)]);
  }
}
function sourceKey(source: MdfBoardSource): string { return JSON.stringify([source.kind, source.id]); }

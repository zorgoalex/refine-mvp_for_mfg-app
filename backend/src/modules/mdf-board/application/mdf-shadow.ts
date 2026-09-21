import { createHash } from 'node:crypto';
import type { TransactionClient } from '../../../database/database.types';
import { beforeTransactionCommit } from '../../../database/transaction-hooks';
import type { MdfBoardEventInput, MdfBoardSource } from '../../status-automation/application/mdf-board-event.types';
import { loadMdfShadowSource, type MdfShadowRow } from '../adapters/mdf-shadow-source';
import { calculateMdfQuantities, mdfSum, type MdfPositionQuantity, type MdfQuantityEvidence } from '../domain/mdf-quantities';
import { recordMdfReceipt, type MdfReceiptLine } from './mdf-receipt';
import { normalizeMdfShadowCommand, type MdfShadowCommand } from './mdf-shadow-command';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface PendingShadow {
  sources: Map<string, MdfBoardEventInput>;
  commands: { input: MdfBoardEventInput; prepared: ReturnType<typeof prepareMdfShadowCommand> }[];
}
const pending = new WeakMap<TransactionClient, PendingShadow>();

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
  pendingShadow(tx).sources.set(sourceKey(input.source), cloneInput(input));
}

/** Capture at the explicit command point, before legacy forward rules. Separate
 * queue: generic dispatch must not overwrite human intent or a correction.
 * No source/domain locks here; this is unaccepted diagnostic provenance only. */
export async function observeMdfShadowCommand(tx: TransactionClient, input: MdfBoardEventInput,
  command: MdfShadowCommand): Promise<void> {
  if (process.env.BACKEND_MDF_SHADOW_INTAKE !== 'true') return;
  const captured = cloneInput(input);
  const intent = { ...command };
  normalizeMdfShadowCommand(captured.source, intent);
  const state = pendingShadow(tx);
  const rows = await loadMdfShadowSource(tx, captured.source);
  state.commands.push({ input: captured, prepared: prepareMdfShadowCommand(captured, intent, rows) });
}

export function prepareMdfShadowCommand(input: MdfBoardEventInput, command: MdfShadowCommand,
  rows: readonly MdfShadowRow[]) {
  const intent = normalizeMdfShadowCommand(input.source, command);
  const prepared = prepareMdfShadow(rows.map(row => ({ ...row, cut: false, laminated: false })));
  // Ignore mutable visual/status/timestamp fields, not identity, quantity or eligibility.
  return { ...prepared, command: intent, compositionDigest: mdfShadowCompositionDigest(rows),
    sourceDigest: digest(rows), // Comparison's raw snapshot digest, NOT command envelope.
    receiptDigest: digest([input.source, input.actor.id, input.requestId, input.sourceIdempotencyKey, intent, rows]),
    issues: [...prepared.issues, 'EXPLICIT_COMMAND_UNVERIFIED'].sort() };
}

export function mdfShadowCompositionDigest(rows: readonly MdfShadowRow[]): string {
  return digest(rows.map(row => [row.line_key, row.order_id, row.detail_id, row.quantity,
    row.relevant, row.rework, row.unresolved, row.whole_order]).map(row => JSON.stringify(row)).sort());
}

function cloneInput(input: MdfBoardEventInput): MdfBoardEventInput {
  return { ...input, source: { ...input.source }, actor: { ...input.actor } };
}

function pendingShadow(tx: TransactionClient): PendingShadow {
  let state = pending.get(tx);
  if (!state) {
    state = { sources: new Map(), commands: [] };
    const captured = state;
    beforeTransactionCommit(tx, 'mdf-shadow-intake', async () => {
      try { await captureMdfShadow(tx, captured); }
      finally { pending.delete(tx); }
    });
    pending.set(tx, state);
  }
  return state;
}

async function captureMdfShadow(tx: TransactionClient, state: PendingShadow): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover',0))");
  const mode = (await tx.query<{ mode: string }>('SELECT mode FROM mdf_engine_state WHERE singleton')).rows[0]?.mode;
  if (mode !== 'legacy' && mode !== 'shadow') throw new Error('MDF_SHADOW_MODE_CONFLICT');
  const rules = (await tx.query<{ id: string; version: number }>(`SELECT id,version FROM status_automation_rules
    WHERE is_enabled AND event_type LIKE 'mdf.%' ORDER BY id`)).rows.map(r => ({ ruleId: Number(r.id), version: Number(r.version) }));
  // Load ALL source snapshots before source-head locks; then acquire sources in
  // deterministic order. No calls back into order/status automation from here.
  const snapshots: { input: MdfBoardEventInput;
    prepared: ReturnType<typeof prepareMdfShadow> | ReturnType<typeof prepareMdfShadowCommand> }[] = [...state.commands];
  for (const input of state.sources.values()) snapshots.push({ input, prepared: prepareMdfShadow(await loadMdfShadowSource(tx, input.source)) });
  // Stable same-source order preserves distinct explicit commands; generic final
  // snapshot follows them. All source locks share the existing deterministic order.
  snapshots.sort((a, b) => sourceKey(a.input.source) < sourceKey(b.input.source) ? -1
    : sourceKey(a.input.source) > sourceKey(b.input.source) ? 1 : 0);
  for (const { input, prepared } of snapshots) {
    const source = [input.source.kind, input.source.id];
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mdf-source:${JSON.stringify(source)}`]);
    const head = (await tx.query<{ version: string; correction_epoch: string }>(`SELECT version,correction_epoch
      FROM mdf_source_heads WHERE source_kind=$1 AND source_id=$2 FOR UPDATE`, source)).rows[0];
    const explicit = 'command' in prepared ? prepared : null;
    const revisionKey = `${explicit ? 'shadow-command' : 'shadow'}:${digest(input.sourceIdempotencyKey)}`;
    await recordMdfReceipt(tx, {
      sourceKind: input.source.kind, sourceId: input.source.id, revisionKey, origin: explicit ? 'manual' : 'legacy',
      actorUserId: input.actor.id === null ? null : Number(input.actor.id), requestId: input.requestId, causeKey: input.sourceIdempotencyKey,
      expectedFence: head ? { version: head.version, correctionEpoch: head.correction_epoch } : null,
      sourceDigest: explicit?.receiptDigest ?? prepared.sourceDigest, accept: false, lines: prepared.lines, rules,
    });
    if (explicit) {
      if (input.actor.id === null) throw new Error('MDF_SHADOW_MANUAL_ACTOR_REQUIRED');
      const c = explicit.command;
      // No retention-coupled FK, but provenance must reference this command's
      // actual persisted audit, not merely a well-formed UUID supplied by a caller.
      const auditEvents = c.kind === 'manual_move'
        ? ['mdf_board.manual_move.created', 'mdf_board.manual_move.updated']
        : [c.kind === 'manual_clear' ? 'mdf_board.manual_move.deleted' : 'mdf_board.production_returned'];
      const audit = await tx.query(`SELECT 1 FROM audit_log WHERE audit_id=$1 AND event=ANY($2::text[])
        AND entity_type=$3 AND entity_id=$4 AND user_id=$5 AND request_id=$6
        AND status_code IS NOT DISTINCT FROM $7::text
        AND ($8::bigint IS NULL OR (status_id=$8 AND metadata_json->>'previewDigest'=$9))`,
      [c.auditId, auditEvents, c.kind === 'production_return' ? 'mdf_board_card' : 'mdf_board_manual_move',
        `${input.source.kind}:${input.source.id}`, Number(input.actor.id), input.requestId,
        c.targetColumn, c.targetStageId, c.previewDigest]);
      if (audit.rows.length !== 1) throw new Error('MDF_SHADOW_AUDIT_MISMATCH');
      await tx.query(`INSERT INTO mdf_shadow_commands
        (source_kind,source_id,revision_key,command_kind,target_column,audit_event_id,composition_digest,
         target_stage_id,target_stage_code,preview_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(source_kind,source_id,revision_key) DO NOTHING`,
      [...source, revisionKey, c.kind, c.targetColumn, c.auditId, explicit.compositionDigest,
        c.targetStageId, c.targetStageCode, c.previewDigest]);
    }
    await tx.query(`INSERT INTO mdf_shadow_observations
      (source_kind,source_id,revision_key,source_digest,issues,candidate_quantities)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
    [...source, revisionKey, prepared.sourceDigest, prepared.issues, JSON.stringify(prepared.candidateQuantities)]);
  }
}
function sourceKey(source: MdfBoardSource): string { return JSON.stringify([source.kind, source.id]); }

/**
 * §5.7b initial population (baseline), pure part: turns the 5.7a classification into baseline receipt items under
 * the binding user policy (27.09) and computes the dry-run oracle. No persistence here.
 *
 * Policy: orders at/after «Готов к выдаче» are closed IN FULL by historical status (order-level declarations cut +
 * laminated at full demand; coverage only, never supply); in current orders a legacy manual move present in
 * `audit_log` counts as a declaration «из истории, без привязки к составу»; physical cut only from CNC completion;
 * strict composition-bound proofs as before. Order statuses never change.
 */
import { createHash } from 'node:crypto';
import type { MdfReconciliationSource } from './mdf-reconciliation';
import { calculateMdfQuantities, mdfPositionKey, type MdfPositionQuantity, type MdfQuantityEvidence } from './mdf-quantities';

export const MDF_BASELINE_ALGORITHM = 'mdf-baseline/v1';
const SOURCE_COLUMNS: Record<string, readonly string[]> = {
  packet: ['parsed','completed','completed_laminated'], bazisCutSet: ['parsed','completed','completed_laminated'],
  bath: ['baths','baths_ready','baths_laminated','completed_baths'],
};

export interface MdfBaselineLine {
  lineKey: string; orderId: number; detailId: number; quantity: number;
  stageCode: 'membership' | 'cut' | 'laminated'; evidenceKind: 'derived' | 'physical' | 'declaration'; rework: boolean;
}
export interface MdfBaselineContext {
  sourceCreatedAt: string; displayName: string; priorColumn: string | null; manualPlacementColumn: string | null;
  compositionComplete: true; demand: MdfPositionQuantity[];
}
export type MdfBaselineProvenance = 'physical_cnc' | 'strict_proof' | 'legacy_audited' | 'closed_by_status';
export interface MdfBaselineItem {
  itemKey: string; itemKind: 'source' | 'order_closure';
  sourceKind: 'packet' | 'bazisCutSet' | 'bath' | 'order'; sourceId: string;
  lines: MdfBaselineLine[]; context: MdfBaselineContext;
  provenance: Partial<Record<MdfBaselineProvenance, number>>;
  orderIds: number[]; digest: string;
}
export interface MdfBaselineOrder { id: number; name: string; readyOrLater: boolean; deleted: boolean; kind: string; createdAt: string | null }
export interface MdfBaselineDemandRow extends MdfPositionQuantity { rank: number | null }
export interface MdfBaselineBuild {
  items: MdfBaselineItem[];
  skipped: { itemKey: string; reason: string }[];
  closedOrderIds: number[];
  /** Current (not closed) orders without any credited trace or with only blocked sources: manual review. */
  manualReviewOrderIds: number[];
  itemsDigest: string;
}

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const byLine = (a: MdfBaselineLine, b: MdfBaselineLine) => a.lineKey < b.lineKey ? -1 : a.lineKey > b.lineKey ? 1 : 0;
const byPosition = (a: MdfPositionQuantity, b: MdfPositionQuantity) => a.orderId - b.orderId || a.detailId - b.detailId;

export function mdfBaselineItemDigest(item: Omit<MdfBaselineItem, 'digest'>): string {
  return sha([MDF_BASELINE_ALGORITHM, item.itemKind, item.sourceKind, item.sourceId,
    [...item.lines].sort(byLine).map(l => [l.lineKey, l.orderId, l.detailId, l.quantity, l.stageCode, l.evidenceKind, l.rework]),
    { ...item.context, demand: [...item.context.demand].sort(byPosition).map(d => [d.orderId, d.detailId, d.quantity]) }]);
}

export function buildMdfBaselineItems(input: {
  sources: readonly MdfReconciliationSource[]; demand: readonly MdfBaselineDemandRow[];
  orders: ReadonlyMap<number, MdfBaselineOrder>;
}): MdfBaselineBuild {
  const demandByOrder = new Map<number, MdfPositionQuantity[]>();
  for (const d of input.demand) demandByOrder.set(d.orderId, [...(demandByOrder.get(d.orderId) ?? []),
    { orderId: d.orderId, detailId: d.detailId, quantity: d.quantity }]);
  const isFinished = (id: number) => {
    const o = input.orders.get(id);
    return Boolean(o && o.readyOrLater && !o.deleted && o.kind === 'production_order' && demandByOrder.has(id));
  };
  const items: MdfBaselineItem[] = [], skipped: MdfBaselineBuild['skipped'] = [];
  const finalize = (item: Omit<MdfBaselineItem, 'digest'>) => items.push({ ...item, digest: mdfBaselineItemDigest(item) });

  for (const s of input.sources) {
    if (s.disposition !== 'credited') continue;
    const itemKey = `${s.kind}:${s.id}`;
    const demand = s.owners.flatMap(o => demandByOrder.get(o) ?? []).sort(byPosition);
    if (!s.createdAt || !Number.isFinite(Date.parse(s.createdAt))) { skipped.push({ itemKey, reason: 'SOURCE_CREATED_AT_MISSING' }); continue; }
    if (demand.length > 5000 || s.owners.length > 100) { skipped.push({ itemKey, reason: 'CONTEXT_LIMIT' }); continue; }
    const inDemand = new Set(demand.map(mdfPositionKey));
    const lines: MdfBaselineLine[] = [];
    const provenance: MdfBaselineItem['provenance'] = {};
    const add = (p: MdfBaselineProvenance, q: number) => { provenance[p] = (provenance[p] ?? 0) + q; };
    for (const l of s.lines) {
      if (!inDemand.has(mdfPositionKey(l))) { skipped.push({ itemKey, reason: 'LINE_OUTSIDE_DEMAND' }); continue; }
      lines.push({ lineKey: l.line, orderId: l.orderId, detailId: l.detailId, quantity: l.quantity,
        stageCode: l.stage, evidenceKind: l.evidence, rework: l.rework });
      if (l.stage === 'cut' && l.evidence === 'physical') add('physical_cnc', l.quantity);
      if (l.evidence === 'declaration') add('strict_proof', l.quantity);
    }
    // (b) audited legacy manual move in a CURRENT order: declaration per position of current owners, never supply.
    const rework = s.lines.some(l => l.stage === 'membership' && l.rework);
    if (s.warnings.includes('HISTORY_AUDITED_UNBOUND') && !rework) {
      const stage = s.kind === 'bath' ? 'laminated' : 'cut';
      const perPosition = new Map<string, MdfPositionQuantity>();
      for (const l of s.lines) if (l.stage === 'membership' && !isFinished(l.orderId) && inDemand.has(mdfPositionKey(l))) {
        const k = mdfPositionKey(l), prev = perPosition.get(k);
        perPosition.set(k, { orderId: l.orderId, detailId: l.detailId, quantity: (prev?.quantity ?? 0) + l.quantity });
      }
      for (const [k, p] of [...perPosition].sort(([a], [b]) => a < b ? -1 : 1)) {
        lines.push({ lineKey: `legacy-audited:${k}`, ...p, stageCode: stage, evidenceKind: 'declaration', rework: false });
        add('legacy_audited', p.quantity);
      }
    }
    if (!lines.some(l => l.stageCode === 'membership')) { skipped.push({ itemKey, reason: 'MEMBERSHIP_MISSING' }); continue; }
    const columns = SOURCE_COLUMNS[s.kind];
    finalize({ itemKey, itemKind: 'source', sourceKind: s.kind, sourceId: s.id, lines: lines.sort(byLine),
      context: { sourceCreatedAt: s.createdAt, displayName: s.displayName ?? `${s.kind} ${s.id}`,
        priorColumn: s.legacyColumn && columns.includes(s.legacyColumn) ? s.legacyColumn : null,
        manualPlacementColumn: s.manualColumn && columns.includes(s.manualColumn) ? s.manualColumn : null,
        compositionComplete: true, demand },
      provenance, orderIds: [...s.owners] });
  }

  // (a) finished orders: closed in full by historical status.
  const closedOrderIds = [...demandByOrder.keys()].filter(isFinished).sort((a, b) => a - b);
  for (const id of closedOrderIds) {
    const order = input.orders.get(id)!;
    const demand = [...demandByOrder.get(id)!].sort(byPosition);
    if (demand.length > 5000) { skipped.push({ itemKey: `order:${id}`, reason: 'CONTEXT_LIMIT' }); continue; }
    const lines: MdfBaselineLine[] = demand.filter(d => d.quantity > 0).flatMap(d => (['cut', 'laminated'] as const)
      .map(stage => ({ lineKey: `closed-by-status:${d.detailId}:${stage}`, orderId: id, detailId: d.detailId,
        quantity: d.quantity, stageCode: stage, evidenceKind: 'declaration' as const, rework: false })));
    finalize({ itemKey: `order:${id}`, itemKind: 'order_closure', sourceKind: 'order', sourceId: String(id),
      lines: lines.sort(byLine),
      context: { sourceCreatedAt: order.createdAt && Number.isFinite(Date.parse(order.createdAt)) ? order.createdAt
        : '1970-01-01T00:00:00Z', displayName: `Заказ ${order.name || id}`, priorColumn: null,
      manualPlacementColumn: null, compositionComplete: true, demand },
      provenance: { closed_by_status: demand.reduce((n, d) => n + d.quantity, 0) }, orderIds: [id] });
  }

  const traced = new Set(items.filter(i => i.itemKind === 'source' && i.lines.some(l => l.stageCode !== 'membership'))
    .flatMap(i => i.lines.filter(l => l.stageCode !== 'membership').map(l => l.orderId)));
  const manualReviewOrderIds = [...demandByOrder.keys()].filter(id => !isFinished(id) && !traced.has(id)).sort((a, b) => a - b);
  items.sort((a, b) => a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0);
  return { items, skipped, closedOrderIds, manualReviewOrderIds,
    itemsDigest: sha(items.map(i => [i.itemKey, i.digest])) };
}

/** Dry-run oracle v1: expected per-position credit under the binding policy, computed with the engine's own
 * quantity arithmetic over the items' evidence (closure declarations count as whole-position coverage). */
export function expectMdfBaseline(build: MdfBaselineBuild, demand: readonly MdfPositionQuantity[]) {
  const evidence: MdfQuantityEvidence[] = build.items.flatMap(i => i.lines.filter(l => l.stageCode !== 'membership')
    .map(l => ({ orderId: l.orderId, detailId: l.detailId, quantity: l.quantity, source: i.itemKey, line: l.lineKey,
      stage: l.stageCode as 'cut' | 'laminated', kind: l.evidenceKind, rework: l.rework })));
  const inScope = new Set(build.items.flatMap(i => i.orderIds));
  const scoped = demand.filter(d => inScope.has(d.orderId));
  return calculateMdfQuantities({ demand: scoped,
    evidence: evidence.filter(e => scoped.some(d => d.orderId === e.orderId && d.detailId === e.detailId)) }).positions;
}

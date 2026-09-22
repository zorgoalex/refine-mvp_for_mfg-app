import { createHash } from 'node:crypto';
import { mdfPositionKey, mdfQuantity, type MdfPositionQuantity } from './mdf-quantities';

/** Server-normalized command context, frozen BEFORE detail/status side effects.
 * Demand covers all MDF positions of every owner, not only source membership.
 * A visual column is retained for display continuity, never production proof.
 * Authorization/provenance and complete demand loading remain command-owned. */
export interface MdfExecutionContext {
  sourceCreatedAt: string;
  displayName: string;
  priorColumn: string | null;
  /** Explicit placement only. Omitted on v1 receipts; null clears an override. */
  manualPlacementColumn?: string | null;
  /** Internal durable job effect policy. Omitted on old/ordinary receipts. */
  effectPolicy?: 'forward' | 'publish_only';
  compositionComplete: boolean;
  demand: readonly MdfPositionQuantity[];
}

export function mdfDemandDigest(rows: readonly MdfPositionQuantity[]): string {
  return createHash('sha256').update(JSON.stringify([...rows].sort((a,b) => a.orderId-b.orderId || a.detailId-b.detailId)
    .map(d => [d.orderId,d.detailId,d.quantity]))).digest('hex');
}

export function snapshotMdfExecutionContext(input: MdfExecutionContext): MdfExecutionContext {
  const invalid = (): never => { throw new Error('MDF_EXECUTION_CONTEXT_INVALID'); };
  if (!input || typeof input.sourceCreatedAt !== 'string' || !Number.isFinite(Date.parse(input.sourceCreatedAt))
    || typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.length > 2000
    || input.displayName.includes('\0') || typeof input.compositionComplete !== 'boolean'
    || (input.priorColumn !== null && !['parsed', 'completed', 'completed_laminated', 'baths',
      'baths_ready', 'baths_laminated', 'completed_baths'].includes(input.priorColumn))
    || (input.manualPlacementColumn !== undefined && input.manualPlacementColumn !== null
      && !['parsed', 'completed', 'completed_laminated', 'baths', 'baths_ready', 'baths_laminated', 'completed_baths']
        .includes(input.manualPlacementColumn))
    || (input.effectPolicy !== undefined && input.effectPolicy !== 'forward' && input.effectPolicy !== 'publish_only')
    || !Array.isArray(input.demand) || (!input.demand.length && input.compositionComplete) || input.demand.length > 5000) invalid();
  const ids = new Set<number>(), orders = new Set<number>();
  const demand = input.demand.map(row => {
    try { mdfPositionKey(row); mdfQuantity(row.quantity); } catch { return invalid(); }
    if (ids.has(row.detailId)) invalid();
    ids.add(row.detailId); orders.add(row.orderId);
    return { orderId: row.orderId, detailId: row.detailId, quantity: row.quantity };
  }).sort((a,b) => a.orderId-b.orderId || a.detailId-b.detailId);
  if (orders.size > 100) invalid();
  return { sourceCreatedAt: new Date(input.sourceCreatedAt).toISOString(), displayName: input.displayName,
    priorColumn: input.priorColumn, compositionComplete: input.compositionComplete, demand,
    // Preserve old receipt digests: do not attach a field absent from v1 input.
    ...(input.manualPlacementColumn === undefined ? {} : { manualPlacementColumn: input.manualPlacementColumn }),
    ...(input.effectPolicy === undefined ? {} : { effectPolicy: input.effectPolicy }) };
}

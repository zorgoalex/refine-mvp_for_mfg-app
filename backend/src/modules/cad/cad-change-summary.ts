import type { CadGroup } from '../../shared/cad-workspace';
import type { CadSourceStatus } from '../../shared/cad-api';
import { canonicalCad } from './cad-editor-rules';

/** Full snapshots are already durable in cad_variant_revisions. Never copy them into audit. */
export function cadChangeSummary(beforeRevision: number, before: CadGroup[], after: CadGroup[]) {
  const old = new Map(before.map(g => [g.id, g])), next = new Map(after.map(g => [g.id, g]));
  const summarize = (ids: string[]) => ({ count: ids.length, ids: ids.slice(0, 50), truncated: ids.length > 50 });
  return { beforeRevision, revision: beforeRevision + 1, beforeCount: before.length, afterCount: after.length,
    added: summarize(after.filter(g => !old.has(g.id)).map(g => g.id)),
    removed: summarize(before.filter(g => !next.has(g.id)).map(g => g.id)),
    modified: summarize(after.filter(g => old.has(g.id) && canonicalCad(old.get(g.id)) !== canonicalCad(g)).map(g => g.id)) };
}

export function cadSourceAuditSummary(sources: CadSourceStatus[]) {
  const changed = sources.filter(s => s.stale);
  const sample: Array<{ orderId: number; detailId: number }> = [];
  let detailCount = 0;
  for (const source of sources) {
    detailCount += source.changedDetailIds.length;
    for (const detailId of source.changedDetailIds.slice(0, 50 - sample.length)) sample.push({ orderId: source.orderId, detailId });
  }
  return { sourceCount: sources.length, changedSourceCount: changed.length,
    changedOrderIds: changed.slice(0, 50).map(s => s.orderId), ordersTruncated: changed.length > 50,
    changedDetailCount: detailCount, changedDetails: sample, detailsTruncated: detailCount > sample.length };
}

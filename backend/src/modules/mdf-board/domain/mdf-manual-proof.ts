import { createHash } from 'node:crypto';
import type { MdfReceiptLine } from '../application/mdf-receipt';
import type { MdfBoardSource } from '../../status-automation/application/mdf-board-event.types';
import { mdfSum } from './mdf-quantities';
import { isMdfEvidenceContract } from './mdf-evidence-contract';

const position = (l: MdfReceiptLine) => JSON.stringify([l.orderId,l.detailId,l.rework]);
/** Explicit current command only. Previous lines must already be accepted and
 * match the locked composition. Never invoke this on diagnostic/history rows.
 * Repeated manual confirmation and CNC proof refer to the same source portion,
 * not two shipments. Clear/terminal placement preserve all existing evidence.
 */
export function addMdfManualProof(source: MdfBoardSource, previous: readonly MdfReceiptLine[],
  target: string | null, causeKey: string): { lines: MdfReceiptLine[]; added: MdfReceiptLine[] } {
  const columns = source.kind === 'bath' ? ['baths','baths_ready','baths_laminated','completed_baths']
    : ['parsed','completed','completed_laminated'];
  if (target !== null && !columns.includes(target)) throw new Error('MDF_MANUAL_TARGET_INVALID');
  const stage = source.kind === 'bath' ? target === 'baths_laminated' ? 'laminated' : null
    : target === 'completed' ? 'cut' : null;
  const lines = previous.map(l => ({ ...l }));
  const keys = new Set<string>();
  const members = new Map<string,MdfReceiptLine>();
  const proof = new Map<string,number>();
  for (const l of lines) {
    if (keys.has(l.lineKey) || !isMdfEvidenceContract(source.kind,l.stageCode,l.evidenceKind)
      || ![l.orderId,l.detailId,l.quantity].every(n => Number.isSafeInteger(n) && n > 0)) {
      throw new Error('MDF_MANUAL_EVIDENCE_INVALID');
    }
    keys.add(l.lineKey);
    const key = position(l);
    if (l.stageCode === 'membership') members.set(key, { ...l, quantity: mdfSum(members.get(key)?.quantity ?? 0,l.quantity) });
    if (l.evidenceKind === 'physical') proof.set(key,mdfSum(proof.get(key) ?? 0,l.quantity));
  }
  if (!members.size || [...proof].some(([key,q]) => q > (members.get(key)?.quantity ?? 0))) {
    throw new Error('MDF_MANUAL_EVIDENCE_INVALID');
  }
  const added: MdfReceiptLine[] = [];
  if (stage) for (const [key, member] of [...members].sort(([a],[b]) => a.localeCompare(b))) {
    const quantity = member.quantity - (proof.get(key) ?? 0);
    if (!quantity) continue;
    const lineKey = `manual:${createHash('sha256').update(JSON.stringify([source,stage,key,causeKey])).digest('hex')}`;
    if (keys.has(lineKey)) throw new Error('MDF_MANUAL_EVIDENCE_INVALID');
    added.push({ ...member, lineKey, quantity, stageCode: stage, evidenceKind: 'physical' });
  }
  return { lines: [...lines,...added], added };
}

/** Opaque concurrency token, NOT an authorization token. Owner RBAC remains
 * mandatory; source identity/epoch/version prevent cross-card or stale replay. */
export function mdfSourceCommandToken(source: MdfBoardSource, head: {
  received: string; version: string; epoch: string;
}): string {
  return createHash('sha256').update(JSON.stringify(['mdf-command-v1',source.kind,source.id,
    head.received,head.version,head.epoch])).digest('hex');
}

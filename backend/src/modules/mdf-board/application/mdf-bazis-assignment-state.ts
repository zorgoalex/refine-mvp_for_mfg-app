import { createHash } from 'node:crypto';
import { mdfPositionKey, mdfQuantity } from '../domain/mdf-quantities';
import type { MdfSourceKind } from './mdf-job-runner';

export interface MdfBazisMembershipFact {
  lineKey: string;
  orderId: number;
  detailId: number;
  quantity: number;
  rework: boolean;
  stageCode: string;
  evidenceKind: string;
}

export interface MdfValidatedBazisAssignmentState {
  readonly sourceKind: 'bazisCutSet';
  readonly sourceId: string;
  readonly revisionKey: string;
  readonly assignmentStateId: string;
  readonly rootIntentId: string;
  readonly membershipDigest: string;
  readonly intentionalEmpty: boolean;
}

const issued = new WeakSet<object>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Canonical digest shared by the composition writer and sealed-state loader. */
export function mdfBazisMembershipDigest(lines: readonly MdfBazisMembershipFact[]): string {
  const seen = new Set<string>();
  const rows = lines.filter(line => line.stageCode === 'membership' && line.evidenceKind === 'derived')
    .map(line => {
      mdfPositionKey(line);
      if (typeof line.lineKey !== 'string' || !line.lineKey.trim() || line.lineKey.length > 240
        || !mdfQuantity(line.quantity) || typeof line.rework !== 'boolean' || seen.has(line.lineKey)) {
        throw new Error('MDF_ASSIGNMENT_STATE_INVALID');
      }
      seen.add(line.lineKey);
      return [line.lineKey,line.orderId,line.detailId,line.quantity,line.rework] as const;
    }).sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/** Issuance is reserved for the DB snapshot adapter after validating sealed rows. */
export function issueMdfValidatedBazisAssignmentState(value: MdfValidatedBazisAssignmentState): MdfValidatedBazisAssignmentState {
  if (value.sourceKind !== 'bazisCutSet' || !value.sourceId.trim() || !value.revisionKey.trim()
    || !UUID.test(value.assignmentStateId) || !UUID.test(value.rootIntentId)
    || !/^[a-f0-9]{64}$/.test(value.membershipDigest) || typeof value.intentionalEmpty !== 'boolean') {
    throw new Error('MDF_ASSIGNMENT_STATE_INVALID');
  }
  const descriptor = Object.freeze({ ...value });
  issued.add(descriptor);
  return descriptor;
}

/** A JSON-cloned or caller-reconstructed marker is deliberately not authority. */
export function matchesMdfValidatedBazisAssignmentState(input: {
  sourceKind: MdfSourceKind; sourceId: string; revisionKey: string;
  lines: readonly MdfBazisMembershipFact[];
  state: MdfValidatedBazisAssignmentState | undefined;
}): boolean {
  const state = input.state;
  if (!state || !issued.has(state as object) || input.sourceKind !== 'bazisCutSet'
    || state.sourceKind !== input.sourceKind || state.sourceId !== input.sourceId
    || state.revisionKey !== input.revisionKey) return false;
  try {
    const members = input.lines.filter(line => line.stageCode === 'membership' && line.evidenceKind === 'derived');
    return state.intentionalEmpty === (members.length === 0)
      && state.membershipDigest === mdfBazisMembershipDigest(input.lines);
  } catch { return false; }
}

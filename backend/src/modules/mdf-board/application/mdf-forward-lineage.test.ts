import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildMdfForwardLineageManifest, type MdfForwardPhysicalRow } from './mdf-forward-lineage';
import { issueMdfValidatedPhysicalLineage, type MdfValidatedPhysicalLineage } from '../domain/mdf-physical-lineage';
import type { MdfPhysicalLineageManifest } from './mdf-physical-lineage';
import type { MdfReceiptLine } from './mdf-receipt';

const source = { sourceKind: 'bazisCutSet' as const, sourceId: '71' };
const previousRevisionKey = 'accepted-r1';
const rootId = '91000000-0000-4000-8000-000000000001';
const nextId = '92000000-0000-4000-8000-000000000001';

function physical(overrides: Partial<MdfReceiptLine> = {}): MdfReceiptLine {
  return { lineKey: 'cut:11', orderId: 9, detailId: 11, quantity: 10,
    stageCode: 'cut', evidenceKind: 'physical', rework: false, ...overrides };
}

function previousDescriptor(row: MdfForwardPhysicalRow): MdfValidatedPhysicalLineage {
  const manifest: MdfPhysicalLineageManifest = { operation: 'production', authority: 'manual_production',
    actions: [{ lineKey: row.lineKey, action: 'root' }], droppedPredecessorEvidenceLineIds: [] };
  return issueMdfValidatedPhysicalLineage({ sourceKind: source.sourceKind, sourceId: source.sourceId,
    revisionKey: previousRevisionKey, operation: 'production', productionAuthority: 'manual_production',
    predecessorAcceptedRevisionKey: null,
    manifestDigest: createHash('sha256').update(JSON.stringify(['mdf-physical-lineage-v2', manifest])).digest('hex'),
    droppedPredecessorEvidenceLineIds: [],
    lines: [{ evidenceLineId: row.evidenceLineId, lineKey: row.lineKey, orderId: row.orderId,
      detailId: row.detailId, quantity: row.quantity, stageCode: row.stageCode as 'cut'|'laminated',
      evidenceKind: 'physical', rework: row.rework, action: 'root', predecessorEvidenceLineId: null,
      canonicalOriginEvidenceLineId: row.evidenceLineId }] });
}

describe('buildMdfForwardLineageManifest', () => {
  it('creates an explicit production root from a v1 membership-only predecessor', () => {
    expect(buildMdfForwardLineageManifest({ ...source, predecessorRevisionKey: previousRevisionKey,
      previousPhysicalRows: [], nextLines: [physical()], rootLineKeys: ['cut:11'] })).toEqual({
      operation: 'production', authority: 'manual_production',
      actions: [{ lineKey: 'cut:11', action: 'root' }], droppedPredecessorEvidenceLineIds: [],
    });
  });

  it('carries an exact prior physical fact by its immediate evidence ID and requires roots for new proof', () => {
    const old = { ...physical(), evidenceLineId: rootId };
    const next = [physical(), physical({ lineKey: 'cut:12', detailId: 12, quantity: 3 })];
    expect(buildMdfForwardLineageManifest({ ...source, predecessorRevisionKey: previousRevisionKey,
      previousPhysicalRows: [old], previousLineage: previousDescriptor(old), nextLines: next, rootLineKeys: ['cut:12'] }))
      .toEqual({ operation: 'production', authority: 'manual_production', actions: [
        { lineKey: 'cut:11', action: 'carry', predecessorEvidenceLineId: rootId },
        { lineKey: 'cut:12', action: 'root' },
      ], droppedPredecessorEvidenceLineIds: [] });
    expect(buildMdfForwardLineageManifest({ ...source, predecessorRevisionKey: previousRevisionKey,
      previousPhysicalRows: [old], previousLineage: previousDescriptor(old), nextLines: [physical()], rootLineKeys: [] }))
      .toEqual({ operation: 'carry', actions: [
        { lineKey: 'cut:11', action: 'carry', predecessorEvidenceLineId: rootId },
      ], droppedPredecessorEvidenceLineIds: [] });
  });

  it('fails closed on missing/stale predecessor capability, changed proof, omission, or key rebinding', () => {
    const old = { ...physical(), evidenceLineId: rootId };
    const lineage = previousDescriptor(old);
    const next = [physical()];
    const build = (overrides: Partial<Parameters<typeof buildMdfForwardLineageManifest>[0]>) =>
      buildMdfForwardLineageManifest({ ...source, predecessorRevisionKey: previousRevisionKey,
        previousPhysicalRows: [old], previousLineage: lineage, nextLines: next, rootLineKeys: [], ...overrides });

    expect(() => build({ previousLineage: undefined })).toThrow('MDF_LINEAGE_REQUIRED');
    expect(() => build({ predecessorRevisionKey: 'stale-r0' })).toThrow('MDF_LINEAGE_REQUIRED');
    expect(() => build({ previousPhysicalRows: [{ ...old, quantity: 9 }] })).toThrow('MDF_LINEAGE_REQUIRED');
    expect(() => build({ nextLines: [] })).toThrow('MDF_LINEAGE_INVALID');
    expect(() => build({ nextLines: [physical({ lineKey: 'cut:renamed' })] })).toThrow('MDF_LINEAGE_INVALID');
    expect(() => build({ rootLineKeys: ['cut:11'] })).toThrow('MDF_LINEAGE_INVALID');
    expect(() => build({ rootLineKeys: ['cut:11', 'cut:11'] })).toThrow('MDF_LINEAGE_INVALID');
  });

  it('does not invent physical authority for declarations or membership-only input', () => {
    expect(() => buildMdfForwardLineageManifest({ ...source, predecessorRevisionKey: previousRevisionKey,
      previousPhysicalRows: [], nextLines: [physical({ evidenceKind: 'declaration' })], rootLineKeys: ['cut:11'] }))
      .toThrow('MDF_LINEAGE_INVALID');
    expect(() => buildMdfForwardLineageManifest({ ...source, predecessorRevisionKey: previousRevisionKey,
      previousPhysicalRows: [], nextLines: [], rootLineKeys: [] })).toThrow('MDF_LINEAGE_REQUIRED');
  });
});

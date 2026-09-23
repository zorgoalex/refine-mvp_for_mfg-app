import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { planMdfQuarantinedAllocations, type MdfAllocationSource } from './mdf-allocation-quarantine';
import type { MdfEvidenceAllocation } from './mdf-evidence-allocation';
import { issueMdfValidatedPhysicalLineage, type MdfValidatedPhysicalLine } from './mdf-physical-lineage';

const source = (id: string, kind: MdfAllocationSource['kind'] = 'packet', detailId = 11,
  quantity = 10): MdfAllocationSource => ({ kind, id, accepted: '1', received: '1', createdAt: '2026-09-01',
  lines: [
    { evidenceLineId: `${id}-member`, revision: '1', orderId: 1, detailId, quantity,
      stage: 'membership', evidence: 'derived', rework: false },
    ...(kind === 'bath' ? [] : [{ evidenceLineId: `${id}-cut`, revision: '1', orderId: 1, detailId, quantity,
      stage: 'cut', evidence: 'physical', rework: false }]),
  ] });
const allocation = (patch: Partial<MdfEvidenceAllocation> = {}): MdfEvidenceAllocation => ({
  allocationId: 'a1', evidenceLineId: 'cnc-cut', bathId: 'old', bathRevision: '1',
  orderId: 1, detailId: 11, quantity: 10, state: 'reserved', ...patch,
});
const plan = (sources: MdfAllocationSource[], allocations: MdfEvidenceAllocation[] = []) =>
  planMdfQuarantinedAllocations({ sources, allocations, orderIds: [1, 2] });

function attachIssuedLineage(sourceRow: MdfAllocationSource, options: {
  action?: 'root' | 'carry'; predecessorEvidenceLineId?: string; canonicalOriginEvidenceLineId?: string;
} = {}) {
  const action = options.action ?? 'root';
  const physical = sourceRow.lines.filter(line => line.evidence === 'physical');
  const actions = physical.map(line => action === 'root'
    ? { lineKey: line.lineKey!, action: 'root' }
    : { lineKey: line.lineKey!, action: 'carry', predecessorEvidenceLineId: options.predecessorEvidenceLineId! })
    .sort((a, b) => a.lineKey < b.lineKey ? -1 : a.lineKey > b.lineKey ? 1 : 0);
  const operation = action === 'root' ? 'production' : 'carry';
  const manifest = operation === 'production'
    ? { operation, authority: 'manual_production' as const, actions, droppedPredecessorEvidenceLineIds: [] as const }
    : { operation, actions, droppedPredecessorEvidenceLineIds: [] as const };
  const manifestDigest = createHash('sha256')
    .update(JSON.stringify(['mdf-physical-lineage-v2', manifest])).digest('hex');
  const lines: MdfValidatedPhysicalLine[] = physical.map(line => ({
    evidenceLineId: line.evidenceLineId,
    lineKey: line.lineKey!,
    orderId: line.orderId,
    detailId: line.detailId,
    quantity: line.quantity,
    stageCode: line.stage as 'cut' | 'laminated',
    evidenceKind: 'physical',
    rework: line.rework,
    action,
    predecessorEvidenceLineId: action === 'root' ? null : options.predecessorEvidenceLineId!,
    canonicalOriginEvidenceLineId: action === 'root'
      ? line.evidenceLineId : options.canonicalOriginEvidenceLineId ?? options.predecessorEvidenceLineId!,
  }));
  sourceRow.lineage = issueMdfValidatedPhysicalLineage({
    sourceKind: sourceRow.kind as 'packet' | 'bazisCutSet' | 'bath',
    sourceId: sourceRow.id,
    revisionKey: sourceRow.accepted!,
    operation,
    productionAuthority: operation === 'production' ? 'manual_production' : null,
    predecessorAcceptedRevisionKey: operation === 'production' ? null : '0',
    manifestDigest,
    droppedPredecessorEvidenceLineIds: [],
    lines,
  });
  return sourceRow;
}

describe('dependency-local MDF accounting quarantine', () => {
  it('uses verified independent SAME-position supply despite an unaccepted packet', () => {
    const result = plan([{ ...source('unknown'), accepted: null }, source('basis', 'bazisCutSet'), source('bath', 'bath')]);
    expect(result.readyBathIds).toEqual(['bath']);
    expect(result.reservations.map(r => r.evidenceLineId)).toEqual(['basis-cut']);
    expect(result.quarantine).toContainEqual(expect.objectContaining({ sourceId: 'unknown', code: 'ACCEPTANCE_PENDING', positionKeys: [] }));
  });
  it('blocks unknown bath consumption only on its positions, including accepted AND received members', () => {
    const pending = source('unknown', 'bath'); pending.received = '2';
    pending.lines.push({ ...pending.lines[0], evidenceLineId: 'new-member', revision: '2', detailId: 12 });
    const result = plan([pending, source('cnc'), source('other', 'packet', 13), source('blocked', 'bath'), source('safe', 'bath', 13)]);
    expect(result.readyBathIds).toEqual(['safe']);
    expect(result.blockedPositionKeys).toEqual(['1:11', '1:12']);
  });
  it('missing bath membership explicitly widens quarantine to its known owner, not unrelated orders', () => {
    const bad = source('bad', 'bath'); bad.lines = [{ ...bad.lines[0], stage: 'laminated', evidence: 'physical' }];
    const safe = [source('other'), source('safe', 'bath')].map(s => ({ ...s, lines: s.lines.map(l => ({ ...l, orderId: 2 })) }));
    const result = plan([bad, source('cnc', 'packet', 12), source('blocked', 'bath', 12), ...safe]);
    expect(result.readyBathIds).toEqual(['safe']);
    expect(result.quarantine).toContainEqual(expect.objectContaining({ sourceId: 'bad', orderIds: [1] }));
  });
  it('fully unknown bath ownership quarantines full locked owner scope explicitly', () => {
    const result = plan([{ ...source('unknown', 'bath'), lines: [] }, source('cnc'), source('bath', 'bath')]);
    expect(result.reservations).toEqual([]);
    expect(result.quarantine).toContainEqual(expect.objectContaining({ orderIds: [1, 2] }));
  });
  it('keeps valid OTHER-position reserves of an ineligible mixed bath debited', () => {
    const mixed = source('mixed', 'bath'); mixed.lines.push({ ...mixed.lines[0], evidenceLineId: 'mixed-12', detailId: 12 });
    const result = plan([{ ...source('unknown', 'bath'), accepted: null }, mixed, source('cnc', 'packet', 12), source('new', 'bath', 12)],
      [allocation({ bathId: 'mixed', detailId: 12 })]);
    expect(result.readyBathIds).toEqual([]);
    expect(result.reservations).toEqual([]);
  });
  it('unknown historic supply blocks its allocated position but not other positions of same order', () => {
    const result = plan([source('basis', 'bazisCutSet'), source('blocked', 'bath'), source('other', 'packet', 12), source('safe', 'bath', 12)], [allocation()]);
    expect(result.readyBathIds).toEqual(['safe']);
    expect(result.blockedPositionKeys).toEqual(['1:11']);
  });
  it('conflicting bath revision remains quarantined without stopping another position', () => {
    const result = plan([source('cnc'), { ...source('old', 'bath'), accepted: '2', received: '2',
      lines: source('old', 'bath').lines.map(l => ({ ...l, revision: '2' })) }, source('other', 'packet', 12), source('safe', 'bath', 12)], [allocation()]);
    expect(result.readyBathIds).toEqual(['safe']);
    expect(result.quarantine).toContainEqual(expect.objectContaining({ code: 'COMPOSITION_CHANGED', sourceId: 'old' }));
  });
  it('laminated bath with unaccounted supply blocks only its position and cannot consume', () => {
    const rolled = source('rolled', 'bath'); rolled.lines.push({ ...rolled.lines[0], evidenceLineId: 'rolled-work', stage: 'laminated', evidence: 'physical' });
    const result = plan([rolled, source('other', 'packet', 12), source('safe', 'bath', 12)]);
    expect(result.readyBathIds).toEqual(['safe']);
    expect(result.consumableBathIds).toEqual([]);
    expect(result.quarantine).toContainEqual(expect.objectContaining({ code: 'LAMINATION_SUPPLY_MISSING' }));
  });
  it('is deterministic for reversed sources and lines', () => {
    const sources = [{ ...source('unknown', 'bath'), accepted: null }, source('cnc'), source('blocked', 'bath'), source('other', 'packet', 12), source('safe', 'bath', 12)];
    expect(plan(sources)).toEqual(plan([...sources].reverse().map(s => ({ ...s, lines: [...s.lines].reverse() }))));
  });
  it('quarantined laminated mixed bath never consumes its otherwise valid reserves', () => {
    const mixed = source('mixed', 'bath');
    mixed.lines.push({ ...mixed.lines[0], evidenceLineId: 'mixed-12', detailId: 12 });
    mixed.lines.push(...mixed.lines.map(l => ({ ...l, evidenceLineId: `${l.evidenceLineId}-rolled`, stage: 'laminated', evidence: 'physical' })));
    const result = plan([{ ...source('unknown', 'bath'), accepted: null }, mixed, source('cnc', 'packet', 12)],
      [allocation({ bathId: 'mixed', detailId: 12 })]);
    expect(result.consumableBathIds).toEqual([]);
    expect(result.reservations).toEqual([]);
  });
  it('blocked mixed lamination cannot hide unknown consumption of its OTHER position', () => {
    const mixed = source('mixed', 'bath');
    mixed.lines.push({ ...mixed.lines[0], evidenceLineId: 'mixed-12', detailId: 12 });
    mixed.lines.push(...mixed.lines.map(l => ({ ...l, evidenceLineId: `${l.evidenceLineId}-rolled`, stage: 'laminated', evidence: 'physical' })));
    const result = plan([{ ...source('unknown', 'bath'), accepted: null }, mixed,
      source('cnc', 'packet', 12), source('new', 'bath', 12)]);
    expect(result.readyBathIds).toEqual([]);
    expect(result.blockedPositionKeys).toEqual(['1:11', '1:12']);
  });
  it('blocked mixed bath still reports composition conflicts on other positions', () => {
    const mixed = source('mixed', 'bath');
    mixed.lines.push({ ...mixed.lines[0], evidenceLineId: 'mixed-12', detailId: 12 });
    const result = plan([{ ...source('unknown', 'bath'), accepted: null }, mixed,
      source('cnc', 'packet', 12), source('new', 'bath', 12)],
    [allocation({ bathId: 'mixed', bathRevision: 'old', detailId: 12, quantity: 5 })]);
    expect(result.blockedPositionKeys).toEqual(['1:11', '1:12']);
    expect(result.quarantine).toContainEqual(expect.objectContaining({ sourceId: 'mixed', code: 'COMPOSITION_CHANGED' }));
  });
  it.each(['metadata', 'rework', 'membership'] as const)('quarantines bad bath %s locally', kind => {
    const bad = source('bad', 'bath');
    if (kind === 'metadata') bad.createdAt = undefined;
    if (kind === 'rework') bad.lines[0].rework = true;
    if (kind === 'membership') bad.lines.push({ ...bad.lines[0], evidenceLineId: 'excess', stage: 'laminated', evidence: 'physical', quantity: 11 });
    const result = plan([bad, source('cnc'), source('other', 'packet', 12), source('safe', 'bath', 12)]);
    expect(result.readyBathIds).toEqual(['safe']);
    expect(result.quarantine).toHaveLength(1);
  });
  it('invalid supply membership excludes only that source', () => {
    const bad = source('bad'); bad.lines[1].quantity = 11;
    expect(plan([bad, source('basis', 'bazisCutSet'), source('safe', 'bath')]).readyBathIds).toEqual(['safe']);
  });
  it('keeps legacy v1 aggregate physical proof bounded across multiple lines', () => {
    const legacy = source('legacy-v1');
    legacy.lines.splice(1,1,
      { evidenceLineId:'legacy-v1-cut-a',revision:'1',orderId:1,detailId:11,quantity:6,
        stage:'cut',evidence:'physical',rework:false },
      { evidenceLineId:'legacy-v1-cut-b',revision:'1',orderId:1,detailId:11,quantity:6,
        stage:'cut',evidence:'physical',rework:false });

    const result = plan([legacy, source('bath', 'bath')]);

    expect(result.quarantine).toContainEqual(expect.objectContaining({
      sourceId:'legacy-v1',code:'MEMBERSHIP_MISMATCH',
    }));
    expect(result.reservations).toEqual([]);
  });
  it('accepts overhang only for the exact issued v2 physical snapshot, never a copied capability', () => {
    const authorized = source('lineage-packet', 'packet', 11, 8);
    authorized.lines[1].quantity = 10;
    authorized.lines[1].lineKey = 'cut-current';
    attachIssuedLineage(authorized, {
      action: 'carry', predecessorEvidenceLineId: '11111111-1111-4111-8111-111111111111',
    });
    const targetBath = source('target-bath', 'bath', 11, 10);
    const accepted = plan([authorized, targetBath]);
    expect(accepted.readyBathIds).toEqual(['target-bath']);
    expect(accepted.reservations).toEqual([expect.objectContaining({
      bathId: 'target-bath', evidenceLineId: 'lineage-packet-cut', quantity: 10,
    })]);

    const copiedCapability = { ...authorized, lineage: { ...authorized.lineage! } };
    const independent = source('independent-v1', 'packet', 13, 10);
    const result = plan([copiedCapability, independent, targetBath, source('safe-bath', 'bath', 13, 10)]);
    expect(result.quarantine).toContainEqual(expect.objectContaining({
      sourceId: 'lineage-packet', code: 'LINEAGE_INVALID',
    }));
    expect(result.readyBathIds).toEqual(['safe-bath']);
    expect(result.reservations.map(row => row.evidenceLineId)).toEqual(['independent-v1-cut']);
  });
  it('does not credit a pending source revision even if its prior accepted physical cut was over membership', () => {
    const pending = source('pending-lineage', 'packet', 11, 8);
    pending.lines[1].quantity = 10;
    pending.lines[1].lineKey = 'cut-pending';
    attachIssuedLineage(pending, {
      action: 'carry', predecessorEvidenceLineId: '55555555-5555-4555-8555-555555555555',
    });
    pending.received = '2';
    const independent = source('independent', 'packet', 13, 10);
    const result = plan([pending, independent, source('bath-11', 'bath', 11, 10), source('bath-13', 'bath', 13, 10)]);
    expect(result.reservations.map(row => row.evidenceLineId)).toEqual(['independent-cut']);
    expect(result.quarantine).toContainEqual(expect.objectContaining({ sourceId: 'pending-lineage' }));
    expect(result.readyBathIds).toEqual(['bath-13']);
  });
  it('never remaps a stale canonical-root pin or rework proof into current normal supply', () => {
    const carried = source('carried', 'packet', 11, 8);
    carried.lines[1].quantity = 10;
    carried.lines[1].lineKey = 'cut-child';
    const rootId = '22222222-2222-4222-8222-222222222222';
    attachIssuedLineage(carried, {
      action: 'carry', predecessorEvidenceLineId: rootId, canonicalOriginEvidenceLineId: rootId,
    });
    const rework = source('rework', 'packet', 12, 10);
    rework.lines[1].rework = true;
    rework.lines[1].lineKey = 'cut-rework';
    const independent = source('independent', 'packet', 13, 10);
    const allocations = [
      allocation({ allocationId: 'stale-root-pin', evidenceLineId: rootId, bathId: 'stale-bath', detailId: 11 }),
      allocation({ allocationId: 'rework-pin', evidenceLineId: 'rework-cut', bathId: 'rework-bath', detailId: 12 }),
    ];
    const result = plan([carried, rework, independent, source('stale-bath', 'bath', 11, 10),
      source('rework-bath', 'bath', 12, 10), source('safe-bath', 'bath', 13, 10)], allocations);
    expect(result.blockedPositionKeys).toEqual(['1:11', '1:12']);
    expect(result.readyBathIds).toEqual(['safe-bath']);
    expect(result.reservations.map(row => row.evidenceLineId)).toEqual(['independent-cut']);
  });
  it('overdrawn and misidentified historical evidence cannot free either affected position', () => {
    const result = plan([source('cnc'), source('other', 'packet', 12), source('blocked', 'bath', 12), source('third', 'packet', 13), source('safe', 'bath', 13)],
      [allocation({ detailId: 12, quantity: 11 })]);
    expect(result.blockedPositionKeys).toEqual(['1:11', '1:12']);
    expect(result.readyBathIds).toEqual(['safe']);
  });
  it('discarded tentative reservations cannot leak into final plan', () => {
    const first = source('a-first', 'bath'), rolled = source('z-rolled', 'bath');
    rolled.lines.push({ ...rolled.lines[0], evidenceLineId: 'rolled-work', stage: 'laminated', evidence: 'physical' });
    const result = plan([source('cnc'), first, rolled, source('other', 'packet', 12), source('safe', 'bath', 12)]);
    expect(result.readyBathIds).toEqual(['safe']);
    expect(result.reservations.every(r => r.bathId === 'safe')).toBe(true);
  });
  it('never reallocates released historical evidence or duplicates live debits', () => {
    expect(plan([source('cnc'), source('safe', 'bath')], [allocation({ state: 'released' })]).readyBathIds).toEqual(['safe']);
    expect(() => plan([source('cnc')], [allocation(),allocation()])).toThrow('MDF_ALLOCATION_INVALID_ALLOCATION');
  });
});

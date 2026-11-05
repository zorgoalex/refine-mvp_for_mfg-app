import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { projectMdfAcceptedState, type MdfAcceptedSource, type MdfAcceptedStateInput } from './mdf-accepted-projection';
import { issueMdfValidatedPhysicalLineage, type MdfValidatedPhysicalLine } from './mdf-physical-lineage';
import { issueMdfValidatedBazisAssignmentState, mdfBazisMembershipDigest } from '../application/mdf-bazis-assignment-state';
const packet = '11111111-1111-1111-1111-111111111111';
const source = (kind: MdfAcceptedSource['kind'], id: string, quantity: number, stage?: 'cut'|'laminated'): MdfAcceptedSource => ({
  kind, id, accepted: '1', received: '1', verified: true, priorColumn: kind === 'bath' ? 'baths' : 'parsed', issues: [],
  lines: [{ evidenceLineId: `${kind}:${id}:member`, orderId: 1, detailId: 11, quantity,
    stage: 'membership', evidence: 'derived', rework: false }, ...(stage ? [{ evidenceLineId: `${kind}:${id}:${stage}`,
    orderId: 1, detailId: 11, quantity, stage, evidence: 'physical' as const, rework: false }] : [])],
});
const fixture = (): MdfAcceptedStateInput => ({
  trigger: { kind: 'packet', id: packet },
  sources: [source('packet', packet, 4, 'cut'), source('bazisCutSet', '42', 6, 'cut'), source('bath', 'cut-result:1', 10)],
  details: [{ orderId: 1, detailId: 11, quantity: 10, rank: 1 }],
  readyBathIds: ['cut-result:1'], blockedPositionKeys: [], thresholds: { packed: 8, issued: 9, laminated: 6 },
});
describe('accepted MDF projection shared by jobs and publication', () => {
  it('adds independent CNC/BASIS portions and resolves own machine plus affected bath events', () => {
    const result = projectMdfAcceptedState(fixture());
    expect(result.quantities).toMatchObject({ cut: 10, creditedCut: 10, remaining: 0 });
    expect(result.events.map(e => e.eventType)).toEqual(['mdf.board.completed', 'mdf.board.baths_ready']);
    expect(result.events.every(e => e.scope.details[0].eligibleQuantity === 10)).toBe(true);
    expect(result.cards.find(c => c.kind === 'bath')?.column).toBe('baths_ready');
  });
  it('partial position stays ineligible after demand grows; old status is not quantity', () => {
    const input = fixture(); input.details[0].quantity = 12; input.details[0].rank = 9;
    const result = projectMdfAcceptedState(input);
    expect(result.quantities).toMatchObject({ creditedCut: 10, remaining: 2 });
    expect(result.events[0].scope.details[0]).toEqual({ detailId: 11, requiredQuantity: 12, eligibleQuantity: 10 });
  });
  it('keeps unsupported cards visible without counting them or blocking independent same-position supply', () => {
    const input = fixture(); input.sources[0].verified = false;
    input.sources[0].priorColumn = 'completed'; input.sources[0].issues = ['PROOF_MISSING'];
    input.sources[1].lines.forEach(l => { l.quantity = 10; });
    const result = projectMdfAcceptedState(input);
    expect(result.quantities.creditedCut).toBe(10);
    expect(result.cards[0]).toMatchObject({ column: 'completed', issues: ['PROOF_MISSING'], verified: false });
    expect(result.events.some(e => e.scope.source.kind === 'packet')).toBe(false);
    expect(result.events[0].eventType).toBe('mdf.board.baths_ready');
  });
  it('pending revision excludes stale accepted supply', () => {
    const input = fixture(); input.sources[0].received = '2';
    expect(projectMdfAcceptedState(input).quantities.creditedCut).toBe(6);
  });
  it('never manufactures physical lamination from terminal detail status or prior visual column', () => {
    const input = fixture(); input.details[0].rank = 9; input.sources[2].priorColumn = 'completed_baths';
    const result = projectMdfAcceptedState(input);
    expect(result.quantities.rolled).toBe(0);
    expect(result.cards[2].column).toBe('completed_baths');
    expect(result.events[1].eventType).toBe('mdf.board.baths_ready');
  });
  it('own accepted lamination counts, but cannot move an unrelated position', () => {
    const input = fixture();
    input.sources = [input.sources[0], input.sources[1], source('bath', 'cut-result:1', 10, 'laminated')];
    input.details = [...input.details, { orderId: 1, detailId: 12, quantity: 10, rank: 1 }];
    const result = projectMdfAcceptedState(input);
    expect(result.quantities).toMatchObject({ cut: 0, rolled: 10, remaining: 10 });
    expect(result.events[1]).toMatchObject({ eventType: 'mdf.board.baths_laminated',
      scope: { details: [{ detailId: 11, eligibleQuantity: 10 }] } });
  });
  it('position A excess and position B lamination never compensate each other', () => {
    const input = fixture(); input.sources = [source('packet', packet, 20, 'cut'), source('bath', 'cut-result:1', 5, 'laminated')];
    input.sources[1].lines.forEach(l => { l.detailId = 12; });
    input.details = [...input.details, { orderId: 1, detailId: 12, quantity: 10, rank: 1 }];
    expect(projectMdfAcceptedState(input).quantities).toMatchObject({ cut: 20, rolled: 5,
      creditedCut: 10, creditedRolled: 5, remaining: 5 });
  });
  it('rework is visible in raw totals but never normal eligibility or bath stock', () => {
    const input = fixture(); input.sources[0].lines.forEach(l => { l.rework = true; });
    const result = projectMdfAcceptedState(input);
    expect(result.quantities).toMatchObject({ cut: 10, creditedCut: 6, remaining: 4 });
    expect(result.events.some(e => e.scope.source.kind === 'packet')).toBe(false);
  });
  it.each(['physical','declaration'] as const)('balance-blocked bath %s lamination stays visible but contributes no quantity', evidence => {
    const input = fixture();
    const blockedBath = source('bath','cut-result:blocked',10,'laminated');
    blockedBath.priorColumn = 'baths_laminated';
    blockedBath.lines[1].evidence = evidence;
    input.sources = [blockedBath];
    input.blockedPositionKeys = ['1:11'];

    const result = projectMdfAcceptedState(input);

    expect(result.quantities).toMatchObject({ rolled: 0, creditedRolled: 0, remaining: 10 });
    expect(result.quantities.positions[0]).toMatchObject({ rawRolled: 0, rolled: 0, creditedRolled: 0 });
    expect(result.cards[0]).toMatchObject({ column: 'baths_laminated', verified: true,
      issues: ['ALLOCATION_BASELINE_UNKNOWN'] });
    expect(result.events).toEqual([]);
  });
  it('blocked bath preserves same-position cut and unrelated bath quantities without mutating input', () => {
    const input = fixture(); input.blockedPositionKeys = ['1:11'];
    const blockedBath = source('bath','cut-result:blocked',10,'laminated');
    blockedBath.priorColumn = 'baths_laminated';
    const independentCut = source('packet',packet,4,'cut');
    const unrelatedBath = source('bath','cut-result:unrelated',6,'laminated');
    for (const line of unrelatedBath.lines) { line.orderId = 2; line.detailId = 21; }
    input.sources = [blockedBath,independentCut,unrelatedBath];
    input.details = [...input.details, { orderId: 2, detailId: 21, quantity: 6, rank: 1 }];
    input.readyBathIds = ['cut-result:unrelated'];
    const before = JSON.stringify(input);

    const result = projectMdfAcceptedState(input);

    expect(result.quantities.positions).toEqual([
      expect.objectContaining({ orderId: 1, detailId: 11, rawCut: 4, rawRolled: 0,
        creditedCut: 4, creditedRolled: 0, remaining: 6 }),
      expect.objectContaining({ orderId: 2, detailId: 21, rawRolled: 6,
        creditedRolled: 6, remaining: 0 }),
    ]);
    expect(result.cards.find(card => card.id === 'cut-result:blocked')).toMatchObject({ column: 'baths_laminated',
      issues: ['ALLOCATION_BASELINE_UNKNOWN'] });
    expect(result.events.filter(event => event.scope.source.id === 'cut-result:blocked')).toEqual([]);
    expect(result.events.some(event => event.scope.source.id === 'cut-result:unrelated')).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('never double counts duplicated immutable line identities', () => {
    const input = fixture();
    input.sources[0].lines = [...input.sources[0].lines, input.sources[0].lines[1]];
    expect(() => projectMdfAcceptedState(input)).toThrow('MDF_PROJECTION_DUPLICATE_LINE');
  });
  it.each([['bath','cut'],['packet','laminated'],['bazisCutSet','laminated']] as const)(
    'quarantines invalid %s/%s evidence instead of crediting the wrong stage', (kind,stage) => {
      const input=fixture(); input.sources=[source(kind,'invalid-source',10,stage)];
      const result=projectMdfAcceptedState(input);
      expect(result.quantities).toMatchObject({ cut: 0,rolled: 0,remaining: 10 });
      expect(result.events).toEqual([]);
      expect(result.cards[0].issues).toContain('INVALID_EVIDENCE');
    });
  it('mixed normal/rework membership never increases normal presence or completion requirements', () => {
    const input=fixture(); input.sources=[source('packet',packet,4,'cut')];
    const s=input.sources[0];
    s.lines=[...s.lines,...s.lines.map(l => ({ ...l,evidenceLineId: `${l.evidenceLineId}:rework`,quantity: 6,rework: true }))];
    const result=projectMdfAcceptedState(input);
    expect(result.cards[0].column).toBe('completed');
    expect(result.events[0]).toMatchObject({ eventType: 'mdf.board.completed',scope: { details: [{ eligibleQuantity: 4 }] } });
    expect(result.quantities).toMatchObject({ cut: 10,creditedCut: 4,remaining: 6 });
  });
  it.each([true,false])('declaration overlaps physical work, independent of order (reverse=%s)', reverse => {
    const input = fixture(); const s = input.sources[0];
    s.lines = [...s.lines,{ ...s.lines[1],evidenceLineId: 'decl',quantity: 10,evidence: 'declaration' }];
    if (reverse) s.lines = [...s.lines].reverse();
    const result = projectMdfAcceptedState(input);
    expect(result.quantities).toMatchObject({ cut: 10,creditedCut: 10 });
    expect(result.events[0].scope.details[0].eligibleQuantity).toBe(10);
  });
  it.each(['cut','laminated'] as const)('%s declaration in another card is not additional physical quantity', stage => {
    const input = fixture(); input.details[0].quantity = 15;
    input.sources = stage==='cut' ? [source('packet',packet,6,stage),source('bazisCutSet','42',10,stage)]
      : [source('bath','cut-result:1',6,stage),source('bath','cut-result:2',10,stage)];
    input.sources[1].lines = input.sources[1].lines.map(l => l.stage===stage ? { ...l,evidence: 'declaration' } : l);
    const result = projectMdfAcceptedState(input);
    expect(result.quantities.remaining).toBe(5);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every(e => e.scope.details[0].eligibleQuantity===10)).toBe(true);
  });

  /** Authentic intentional-empty BASIS: no own membership, but preserved
   * physical cut evidence counts toward positions/order; column/reason come
   * from the issued assignment state, never the generic nonempty resolver. */
  function genuineEmptyBasis(id: string): MdfAcceptedSource {
    const row: MdfAcceptedSource = { kind: 'bazisCutSet', id, accepted: '1', received: '1', verified: true,
      priorColumn: 'parsed', issues: [],
      lines: [{ evidenceLineId: `${id}:cut`, lineKey: 'cut', orderId: 1, detailId: 11, quantity: 10,
        stage: 'cut', evidence: 'physical', rework: false }] };
    row.assignmentState = issueMdfValidatedBazisAssignmentState({ sourceKind: 'bazisCutSet', sourceId: id,
      revisionKey: '1', assignmentStateId: '11111111-1111-4111-8111-111111111111',
      rootIntentId: '22222222-2222-4222-8222-222222222222', membershipDigest: mdfBazisMembershipDigest([]),
      intentionalEmpty: true });
    row.lineage = issueBazisLineage(id, row.lines);
    return row;
  }
  function issueBazisLineage(id: string, rows: MdfAcceptedSource['lines']) {
    const physical = rows.filter(l => l.evidence === 'physical');
    const actions = physical.map(l => ({ lineKey: l.lineKey!, action: 'root' as const }))
      .sort((a, b) => a.lineKey < b.lineKey ? -1 : a.lineKey > b.lineKey ? 1 : 0);
    const manifest = { operation: 'production' as const, authority: 'manual_production' as const,
      actions, droppedPredecessorEvidenceLineIds: [] as const };
    const lines: MdfValidatedPhysicalLine[] = physical.map(l => ({ evidenceLineId: l.evidenceLineId,
      lineKey: l.lineKey!, orderId: l.orderId, detailId: l.detailId, quantity: l.quantity,
      stageCode: 'cut', evidenceKind: 'physical', rework: l.rework,
      action: 'root', predecessorEvidenceLineId: null, canonicalOriginEvidenceLineId: l.evidenceLineId }));
    return issueMdfValidatedPhysicalLineage({ sourceKind: 'bazisCutSet', sourceId: id, revisionKey: '1',
      operation: 'production', productionAuthority: 'manual_production', predecessorAcceptedRevisionKey: null,
      manifestDigest: createHash('sha256').update(JSON.stringify(['mdf-physical-lineage-v2', manifest])).digest('hex'),
      droppedPredecessorEvidenceLineIds: [], lines });
  }

  /** Authentic nonempty BASIS with a marked assignment state: the issued marker
   * matches the real NONEMPTY membership digest (intentionalEmpty false) and the
   * genuine physical lineage matches the exact source rows. Such a card must stay
   * on the normal resolver and own-event policy, never the empty bypass. */
  function nonemptyMarkedBasis(id: string): MdfAcceptedSource {
    const membership: MdfAcceptedSource['lines'][number] = { evidenceLineId: `${id}:member`, lineKey: 'member',
      orderId: 1, detailId: 11, quantity: 10, stage: 'membership', evidence: 'derived', rework: false };
    const cut: MdfAcceptedSource['lines'][number] = { evidenceLineId: `${id}:cut`, lineKey: 'cut',
      orderId: 1, detailId: 11, quantity: 10, stage: 'cut', evidence: 'physical', rework: false };
    const row: MdfAcceptedSource = { kind: 'bazisCutSet', id, accepted: '1', received: '1', verified: true,
      priorColumn: 'parsed', issues: [], lines: [membership, cut] };
    row.assignmentState = issueMdfValidatedBazisAssignmentState({ sourceKind: 'bazisCutSet', sourceId: id,
      revisionKey: '1', assignmentStateId: '77777777-7777-4777-8777-777777777777',
      rootIntentId: '88888888-8888-4888-8888-888888888888',
      membershipDigest: mdfBazisMembershipDigest(row.lines.map(l => ({ ...l, lineKey: l.lineKey ?? '',
        stageCode: l.stage, evidenceKind: l.evidence }))),
      intentionalEmpty: false });
    row.lineage = issueBazisLineage(id, row.lines);
    return row;
  }

  it('genuine empty BASIS keeps priorColumn/reason assignment_empty with no issues or events', () => {
    const input = fixture(); input.sources = [genuineEmptyBasis('empty-1')];
    input.details[0].quantity = 10;
    const result = projectMdfAcceptedState(input);
    expect(result.cards[0]).toMatchObject({ column: 'parsed', reason: 'assignment_empty', issues: [], verified: true });
    expect(result.events).toEqual([]);
    // Retained physical cut evidence still counts toward positions/order.
    expect(result.quantities.positions[0]).toMatchObject({ rawCut: 10, creditedCut: 10, remaining: 0 });
    expect(result.cards[0].orderIds).toEqual([1]);
  });

  it('genuine empty BASIS twin with forged lineage does not get the bypass', () => {
    const row = genuineEmptyBasis('forged-lineage');
    row.lineage = issueBazisLineage('other-source', row.lines);
    const input = fixture(); input.sources = [row];
    const result = projectMdfAcceptedState(input);
    expect(result.cards[0].issues).toContain('MDF_ASSIGNMENT_STATE_INVALID');
    expect(result.cards[0].reason).not.toBe('assignment_empty');
    expect(result.events).toEqual([]);
  });

  it('genuine empty BASIS twin with own membership does not get the bypass', () => {
    const row = genuineEmptyBasis('has-members');
    row.lines = [...row.lines, { evidenceLineId: 'has-members:member', lineKey: 'member', orderId: 1, detailId: 11,
      quantity: 10, stage: 'membership', evidence: 'derived', rework: false }];
    row.assignmentState = issueMdfValidatedBazisAssignmentState({ sourceKind: 'bazisCutSet', sourceId: row.id,
      revisionKey: '1', assignmentStateId: '33333333-3333-4333-8333-333333333333',
      rootIntentId: '44444444-4444-4444-8444-444444444444', membershipDigest: mdfBazisMembershipDigest([]),
      intentionalEmpty: true });
    const input = fixture(); input.sources = [row];
    const result = projectMdfAcceptedState(input);
    expect(result.cards[0].issues).toContain('MDF_ASSIGNMENT_STATE_INVALID');
    expect(result.cards[0].reason).not.toBe('assignment_empty');
    expect(result.events).toEqual([]);
  });

  it('empty-claim marker over nonempty BASIS rows is rejected, never the bypass', () => {
    const input = fixture(); input.sources = [source('bazisCutSet', '42', 6, 'cut')];
    input.sources[0].assignmentState = issueMdfValidatedBazisAssignmentState({ sourceKind: 'bazisCutSet',
      sourceId: '42', revisionKey: '1', assignmentStateId: '55555555-5555-4555-8555-555555555555',
      rootIntentId: '66666666-6666-4666-8666-666666666666', membershipDigest: mdfBazisMembershipDigest([]),
      intentionalEmpty: true });
    const result = projectMdfAcceptedState(input);
    expect(result.cards[0].issues).toContain('MDF_ASSIGNMENT_STATE_INVALID');
    expect(result.cards[0].verified).toBe(false);
    expect(result.cards[0].reason).not.toBe('assignment_empty');
    expect(result.cards[0].reason).toBe('requires_verification');
    expect(result.events).toEqual([]);
  });

  it('verified nonempty BASIS with marked state and genuine lineage keeps normal resolver reason/column and own events', () => {
    const row = nonemptyMarkedBasis('nonempty-1');
    const input = fixture(); input.sources = [row]; input.trigger = { kind: 'bazisCutSet', id: row.id };
    input.details[0].quantity = 10;
    const result = projectMdfAcceptedState(input);
    // Fully authentic: issued state matches the real NONEMPTY membership digest and
    // genuine physical lineage matches the exact source rows.
    expect(result.cards[0]).toMatchObject({ verified: true, issues: [] });
    // Normal resolver behavior, never the intentional-empty bypass.
    expect(result.cards[0].reason).toBe('cut_confirmed');
    expect(result.cards[0].reason).not.toBe('assignment_empty');
    expect(result.cards[0].column).toBe('completed');
    // Own event follows the normal trigger policy (full cut on a trigger card).
    expect(result.events.map(e => e.eventType)).toEqual(['mdf.board.completed']);
    expect(result.events[0].scope.source).toEqual({ kind: 'bazisCutSet', id: row.id });
    expect(result.events[0].scope.details).toEqual([{ detailId: 11, requiredQuantity: 10, eligibleQuantity: 10 }]);
    // Nonempty membership owns the order; matching physical cut rows keep the position covered.
    expect(result.cards[0].orderIds).toEqual([1]);
    expect(result.quantities.positions[0]).toMatchObject({ rawCut: 10, creditedCut: 10, remaining: 0 });
  });

  it.each(['parsed','completed','completed_laminated'] as const)(
    'authenticated empty BASIS honors a valid %s manual placement and still emits no automation', column => {
      const row = genuineEmptyBasis('empty-manual');
      row.priorColumn = column === 'parsed' ? 'completed' : 'parsed';
      row.manualPlacementColumn = column;
      const input = fixture(); input.sources = [row];
      const result = projectMdfAcceptedState(input);
      expect(result.cards[0]).toMatchObject({ column, reason: 'assignment_empty', issues: [], verified: true });
      expect(result.events).toEqual([]);
      expect(result.quantities.positions[0]).toMatchObject({ rawCut: 10, creditedCut: 10, remaining: 0 });
    });

  it('authenticated empty BASIS flags an out-of-contract manual column and keeps the prior column', () => {
    const row = genuineEmptyBasis('empty-manual-invalid');
    row.priorColumn = 'completed'; row.manualPlacementColumn = 'baths_laminated';
    const input = fixture(); input.sources = [row];
    const result = projectMdfAcceptedState(input);
    expect(result.cards[0]).toMatchObject({ column: 'completed', reason: 'assignment_empty', verified: true });
    expect(result.cards[0].issues).toEqual(['INVALID_MANUAL_COLUMN']);
    expect(result.events).toEqual([]);
  });
});

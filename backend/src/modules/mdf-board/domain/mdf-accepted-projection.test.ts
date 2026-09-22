import { describe, expect, it } from 'vitest';
import { projectMdfAcceptedState, type MdfAcceptedSource, type MdfAcceptedStateInput } from './mdf-accepted-projection';
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
    const input = fixture(); input.sources[2] = source('bath', 'cut-result:1', 10, 'laminated');
    input.details.push({ orderId: 1, detailId: 12, quantity: 10, rank: 1 });
    const result = projectMdfAcceptedState(input);
    expect(result.quantities).toMatchObject({ cut: 0, rolled: 10, remaining: 10 });
    expect(result.events[1]).toMatchObject({ eventType: 'mdf.board.baths_laminated',
      scope: { details: [{ detailId: 11, eligibleQuantity: 10 }] } });
  });
  it('position A excess and position B lamination never compensate each other', () => {
    const input = fixture(); input.sources = [source('packet', packet, 20, 'cut'), source('bath', 'cut-result:1', 5, 'laminated')];
    input.sources[1].lines.forEach(l => { l.detailId = 12; });
    input.details.push({ orderId: 1, detailId: 12, quantity: 10, rank: 1 });
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
    input.details.push({ orderId: 2, detailId: 21, quantity: 6, rank: 1 });
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
    const input = fixture(); input.sources[0].lines.push(input.sources[0].lines[1]);
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
});

import { describe, expect, it } from 'vitest';
import type { MdfEvidenceAllocation } from '../domain/mdf-evidence-allocation';
import { planMdfCncObservationPinReconciliation, type MdfCncPinLine } from './mdf-cnc-pin-reconciliation';

const REVISION = 'cnc-observation:old';

function line(overrides: Partial<MdfCncPinLine> = {}): MdfCncPinLine {
  return { lineKey: 'cut:one', evidenceLineId: 'evidence-old-1', orderId: 11, detailId: 21,
    quantity: 10, stage: 'cut', evidence: 'physical', rework: false, revision: REVISION, ...overrides };
}

function candidate(overrides: Partial<Omit<MdfCncPinLine, 'revision'>> = {}) {
  const { revision: _revision, ...next } = line({ evidenceLineId: 'candidate-id', ...overrides });
  return next;
}

function member(overrides: Partial<MdfCncPinLine> = {}): MdfCncPinLine {
  return line({ lineKey: 'member:one', evidenceLineId: 'member-old', quantity: 10,
    stage: 'membership', evidence: 'derived', ...overrides });
}

function candidateMember(overrides: Partial<Omit<MdfCncPinLine, 'revision'>> = {}) {
  return candidate({ lineKey: 'member:one', evidenceLineId: 'member-new', quantity: 10,
    stage: 'membership', evidence: 'derived', ...overrides });
}

function debit(overrides: Partial<MdfEvidenceAllocation> = {}): MdfEvidenceAllocation {
  return { allocationId: 'allocation-1', evidenceLineId: 'evidence-old-1', orderId: 11, detailId: 21,
    quantity: 4, bathId: 'bath-1', bathRevision: 'bath-r1', state: 'reserved', ...overrides };
}

function plan(overrides: {
  previousLines?: readonly MdfCncPinLine[];
  nextLines?: readonly ReturnType<typeof candidate>[];
  allocations?: readonly MdfEvidenceAllocation[];
} = {}) {
  return planMdfCncObservationPinReconciliation({
    previousLines: overrides.previousLines ?? [member(), line()],
    nextLines: overrides.nextLines ?? [candidateMember(), candidate()],
    allocations: overrides.allocations ?? [debit()],
  });
}

describe('planMdfCncObservationPinReconciliation', () => {
  it('maps each reserved and consumed pin one-to-one without changing its quantity, state, or bath revision', () => {
    const reserved = debit({ allocationId: 'allocation-reserved', quantity: 3, state: 'reserved' });
    const consumed = debit({ allocationId: 'allocation-consumed', quantity: 5, state: 'consumed' });
    const result = plan({ allocations: [consumed, reserved] });

    expect(result).toEqual([
      { old: consumed, lineKey: 'cut:one', bathRevision: 'bath-r1' },
      { old: reserved, lineKey: 'cut:one', bathRevision: 'bath-r1' },
    ]);
    expect(result).toHaveLength(2);
  });

  it('omits an unallocated old cut declaration while retaining exact physical proof', () => {
    const membership = line({ lineKey: 'member:one', evidenceLineId: 'member-old', stage: 'membership', evidence: 'derived' });
    const declaration = line({ lineKey: 'cut:declared', evidenceLineId: 'decl-old', quantity: 4,
      stage: 'cut', evidence: 'declaration' });
    const physical = line({ lineKey: 'cut:one', evidenceLineId: 'physical-old', quantity: 6 });
    const nextMember = candidate({ lineKey: 'member:one', stage: 'membership', evidence: 'derived', quantity: 10 });
    const nextPhysical = candidate({ lineKey: 'cut:one', quantity: 6 });
    const result = plan({ previousLines: [membership, declaration, physical],
      nextLines: [nextMember, nextPhysical],
      allocations: [debit({ evidenceLineId: 'physical-old', quantity: 2 })] });

    expect(result).toEqual([{ old: debit({ evidenceLineId: 'physical-old', quantity: 2 }),
      lineKey: 'cut:one', bathRevision: 'bath-r1' }]);
  });

  it('fails closed if any live allocation points at an old declaration', () => {
    const declaration = line({ lineKey: 'cut:declared', evidenceLineId: 'decl-old', evidence: 'declaration', quantity: 4 });
    const physical = line({ quantity: 6 });
    expect(plan({ previousLines: [member(), declaration, physical],
      nextLines: [candidateMember(), candidate({ quantity: 6 })],
      allocations: [debit({ evidenceLineId: 'decl-old' })] })).toBeNull();
  });

  it('does not hide malformed evidence when excluding an old declaration', () => {
    const malformed = line({ lineKey: 'cut:declared', evidenceLineId: 'decl-old', evidence: 'declaration', quantity: 0 });
    expect(plan({ previousLines: [member(), malformed, line()],
      nextLines: [candidateMember(), candidate()] })).toBeNull();
    const invalidContract = line({ lineKey: 'bad-declaration', evidenceLineId: 'bad-old',
      stage: 'packed', evidence: 'declaration' });
    expect(plan({ previousLines: [member(), invalidContract, line()],
      nextLines: [candidateMember(), candidate()] })).toBeNull();
  });

  it.each([
    ['changed allocated line key', candidate({ lineKey: 'cut:renamed' })],
    ['changed proof quantity', candidate({ quantity: 9 })],
    ['changed evidence kind', candidate({ evidence: 'declaration' })],
    ['changed stage', candidate({ stage: 'laminated' })],
    ['changed rework class', candidate({ rework: true })],
  ])('rejects %s instead of transferring the pin', (_name, next) => {
    expect(plan({ nextLines: [candidateMember(), next] })).toBeNull();
  });

  it('rejects changed membership even when the pinned physical line is unchanged', () => {
    expect(plan({ nextLines: [candidateMember({ quantity: 9 }), candidate()] })).toBeNull();
  });

  it('rejects mixed prior revisions and duplicate old or candidate line identities', () => {
    expect(plan({ previousLines: [member(), line(), line({ lineKey: 'cut:two', evidenceLineId: 'evidence-old-2', revision: 'r2' })] })).toBeNull();
    expect(plan({ previousLines: [member(), line(), line({ lineKey: 'cut:two' })] })).toBeNull();
    expect(plan({ previousLines: [member(), line(), line({ evidenceLineId: 'evidence-old-2' })] })).toBeNull();
    expect(plan({ nextLines: [candidateMember(), candidate(), candidate()] })).toBeNull();
  });

  it('rejects invalid line or debit quantities and debit identity mismatches', () => {
    expect(plan({ previousLines: [member(), line({ quantity: 0 })] })).toBeNull();
    expect(plan({ previousLines: [member(), line({ quantity: Number.MAX_SAFE_INTEGER + 1 })] })).toBeNull();
    expect(plan({ allocations: [debit({ quantity: 0 })] })).toBeNull();
    expect(plan({ allocations: [debit({ quantity: Number.MAX_SAFE_INTEGER + 1 })] })).toBeNull();
    expect(plan({ allocations: [debit({ orderId: 12 })] })).toBeNull();
    expect(plan({ allocations: [debit({ detailId: 22 })] })).toBeNull();
  });

  it('ignores released history and emits no replacement for it', () => {
    const released = debit({ allocationId: 'released', state: 'released', quantity: 4 });
    expect(plan({ allocations: [released] })).toEqual([]);
  });
});

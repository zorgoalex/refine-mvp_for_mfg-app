import { describe, expect, it } from 'vitest';
import { resolveMdfSourceColumn, type MdfSourceColumnInput } from './mdf-source-column';

const input = (patch: Partial<MdfSourceColumnInput> = {}): MdfSourceColumnInput => ({
  kind: 'packet', memberRanks: [2, 2], compositionComplete: true, cutConfirmed: false,
  manual: null, bathReadiness: 'not_ready', thresholds: { laminated: 3, packed: 4, issued: 5 }, ...patch,
});

describe('normalized MDF source-column resolver (no writes or quantities)', () => {
  it.each([
    ['packet', [4, 4], false, 'parsed'],
    ['packet', [4, 4], true, 'completed_laminated'],
    ['packet', [5, 6], false, 'parsed'],
    ['packet', [5, 6], true, 'completed_laminated'],
    ['bazisCutSet', [5, 6], false, 'completed_laminated'],
    ['packet', [5, null], true, 'completed'],
    ['bazisCutSet', [4, 4], false, 'completed_laminated'],
    ['bazisCutSet', [4, null], false, 'parsed'],
    ['bath', [4, 5], false, 'completed_baths'],
    ['bath', [3, 4], false, 'baths_laminated'],
    ['bath', [3, null], false, 'baths'],
  ] as const)('%s own ranks %j cut=%s -> %s', (kind, memberRanks, cutConfirmed, column) => {
    expect(resolveMdfSourceColumn(input({ kind, memberRanks, cutConfirmed })).column).toBe(column);
  });
  it('laminated/packed own composition does not depend on preliminary cut allocation', () => {
    expect(resolveMdfSourceColumn(input({ kind: 'bath', memberRanks: [3, 3], bathReadiness: 'unknown' })))
      .toMatchObject({ column: 'baths_laminated', reason: 'all_laminated', issues: [] });
    expect(resolveMdfSourceColumn(input({ kind: 'bath', memberRanks: [4, 4], bathReadiness: 'unknown' })).column)
      .toBe('completed_baths');
  });
  it('only an explicit allocation result grants automatic bath readiness', () => {
    expect(resolveMdfSourceColumn(input({ kind: 'bath', cutConfirmed: true, bathReadiness: 'not_ready' })).column).toBe('baths');
    expect(resolveMdfSourceColumn(input({ kind: 'bath', bathReadiness: 'ready' })).column).toBe('baths_ready');
    expect(resolveMdfSourceColumn(input({ kind: 'bath', bathReadiness: 'unknown' })))
      .toMatchObject({ column: null, issues: ['ALLOCATION_BASELINE_UNKNOWN'] });
  });
  it.each(['packet', 'bazisCutSet', 'bath'] as const)('empty/incomplete %s cannot pass every()', kind => {
    expect(resolveMdfSourceColumn(input({ kind, memberRanks: [] })).column).toBeNull();
    expect(resolveMdfSourceColumn(input({ kind, compositionComplete: false, memberRanks: [9] })).column).toBeNull();
  });
  it('preserves visual manual placement, not physical supply', () => {
    const before = input({ kind: 'bath', manual: 'baths_ready', bathReadiness: 'unknown' });
    expect(resolveMdfSourceColumn(before)).toMatchObject({ column: 'baths_ready', reason: 'manual', issues: ['ALLOCATION_BASELINE_UNKNOWN'] });
    expect(before.cutConfirmed).toBe(false);
    expect(before.bathReadiness).toBe('unknown');
    expect(resolveMdfSourceColumn(input({ kind: 'bazisCutSet', manual: 'completed' })).column).toBe('completed');
    expect(resolveMdfSourceColumn(input({ manual: 'completed', memberRanks: [4] })).column).toBe('completed_laminated');
  });
  it('terminal automatic placement retains priority until an actual correction changes facts', () => {
    expect(resolveMdfSourceColumn(input({ cutConfirmed: true, memberRanks: [4], manual: 'parsed' })).column).toBe('completed_laminated');
    expect(resolveMdfSourceColumn(input({ cutConfirmed: false, memberRanks: [2], manual: 'parsed' })).column).toBe('parsed');
  });
  it('requires only thresholds relevant to this source kind', () => {
    expect(resolveMdfSourceColumn(input({ cutConfirmed: true, thresholds: { laminated: null, packed: 4, issued: 5 } })).column).toBe('completed');
    expect(resolveMdfSourceColumn(input({ kind: 'bath', thresholds: { laminated: 3, packed: 4, issued: null } })).column).toBe('baths');
    expect(resolveMdfSourceColumn(input({ thresholds: { laminated: 3, packed: null, issued: 5 } })))
      .toMatchObject({ column: null, issues: ['STAGE_THRESHOLDS_MISSING'] });
  });
  it.each([['packet', 'baths_ready'], ['bath', 'completed'], ['bazisCutSet', 'invented']] as const)
    ('rejects invalid %s manual target %s', (kind, manual) => {
      expect(resolveMdfSourceColumn(input({ kind, manual }))).toMatchObject({ column: null, issues: ['INVALID_MANUAL_COLUMN'] });
    });
});

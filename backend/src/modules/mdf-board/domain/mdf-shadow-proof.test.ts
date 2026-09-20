import { describe, expect, it } from 'vitest';
import { projectMdfShadowProof, type ShadowCommandProof } from './mdf-shadow-proof';

const member = { orderId: 1, detailId: 11, quantity: 3, line: 'member:a', rework: false };
const command = (patch: Partial<ShadowCommandProof> = {}): ShadowCommandProof => ({
  sequence: '1', revision: 'r1', kind: 'manual_move', target: 'completed', compositionDigest: 'a',
  provenanceValid: true, issues: ['SHADOW_ONLY', 'INCOMPLETE_PRODUCER_COVERAGE', 'EXPLICIT_COMMAND_UNVERIFIED'],
  members: [member], ...patch,
});
const project = (commands: ShadowCommandProof[], patch = {}) => projectMdfShadowProof({
  kind: 'packet', compositionDigest: 'a', members: [member], rework: false, rawCut: false, issues: [], commands, ...patch,
});

describe('shadow-only audited command proof folding', () => {
  it('retires only expected sentinels after validation', () => {
    expect(project([command()])).toMatchObject({ cut: true, laminated: false, issues: [], cutRevision: 'r1' });
    expect(project([command({ issues: ['EXPLICIT_COMMAND_UNVERIFIED', 'UNRESOLVED_MEMBERSHIP'] })]))
      .toMatchObject({ cut: false, issues: ['UNRESOLVED_MEMBERSHIP'] });
  });
  it.each([{ provenanceValid: false }, { issues: null }, { members: [] },
    { members: [{ ...member, quantity: 4 }] }, { members: [{ ...member, rework: true }] }])
  ('fails closed on broken provenance or frozen composition: %o', patch => {
    const result = project([command(patch)]);
    expect(result.cut).toBe(false); expect(result.issues.length).toBeGreaterThan(0);
  });
  it('clear and visual moves preserve the physical confirmation; repeats do not add volume', () => {
    expect(project([command(), command({ sequence: '2', revision: 'r2' }),
      command({ sequence: '3', revision: 'r3', kind: 'manual_clear', target: null }),
      command({ sequence: '4', revision: 'r4', target: 'parsed' })]))
      .toMatchObject({ cut: true, cutRevision: 'r2', commandCount: 4 });
  });
  it('uses exact bigint source-local chronology, independent of input order', () => {
    expect(project([command({ sequence: '9007199254740993', kind: 'production_return', target: 'parsed' }),
      command({ sequence: '9007199254740992' })]).cut).toBe(false);
  });
  it('return below cut revokes, later explicit confirmation restores', () => {
    const returned = command({ sequence: '2', kind: 'production_return', target: 'parsed' });
    expect(project([command(), returned])).toMatchObject({ cut: false, cutRevision: null });
    expect(project([command(), returned, command({ sequence: '3', revision: 'new' })]))
      .toMatchObject({ cut: true, cutRevision: 'new' });
    expect(project([returned], { rawCut: true }).cut).toBe(true);
  });
  it('custom stage in completed band preserves earlier cut; return never creates it', () => {
    const returned = command({ sequence: '2', kind: 'production_return', target: 'completed' });
    expect(project([command(), returned]).cut).toBe(true);
    expect(project([returned]).cut).toBe(false);
  });
  it('bath correction revokes only lamination, ready never creates cut', () => {
    const laminated = command({ target: 'baths_laminated' });
    expect(project([laminated], { kind: 'bath' })).toMatchObject({ cut: false, laminated: true });
    for (const target of ['baths', 'baths_ready']) {
      expect(project([laminated, command({ sequence: '2', kind: 'production_return', target })], { kind: 'bath' }))
        .toMatchObject({ cut: false, laminated: false });
    }
    expect(project([laminated, command({ sequence: '2', kind: 'production_return', target: 'baths_laminated' })], { kind: 'bath' }).laminated).toBe(true);
    expect(project([command({ target: 'baths_ready' })], { kind: 'bath' })).toMatchObject({ cut: false, laminated: false });
  });
  it('terminal placement alone does not invent physical work', () => {
    expect(project([command({ target: 'completed_laminated' })]).cut).toBe(false);
    expect(project([command({ target: 'completed_baths' })], { kind: 'bath' }).laminated).toBe(false);
  });
  it('blocks changed composition even if it changed back or raw CNC is completed', () => {
    const result = project([command(), command({ sequence: '2', compositionDigest: 'b' }),
      command({ sequence: '3' })], { rawCut: true });
    expect(result).toMatchObject({ cut: false, issues: ['COMMAND_COMPOSITION_CHANGED'] });
  });
  it('blocks duplicate/invalid sequence rather than guessing chronology', () => {
    for (const commands of [[command(), command()], [command({ sequence: 'bad' })]]) {
      expect(project(commands)).toMatchObject({ cut: false, issues: ['COMMAND_SEQUENCE_INVALID'] });
    }
  });
});

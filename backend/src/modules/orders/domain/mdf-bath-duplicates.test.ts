import { describe, expect, it } from 'vitest';
import {
  archiveHint,
  buildBathDuplicates,
  isCoveredBy,
  pairDigest,
  parseBathCardId,
  sharedDetails,
  type MdfBathSideFacts,
} from './mdf-bath-duplicates';

/** Order 2979: old bath 854 (job 10) and the re-cut 868 (job 11) with the same 18 details. */
function bath(cutResultId: number, patch: Partial<MdfBathSideFacts> = {}): MdfBathSideFacts {
  const cutJobId = cutResultId === 854 ? 10 : cutResultId === 868 ? 11 : cutResultId;
  return {
    bathCardId: `cut-result:${cutResultId}`, cutResultId, cutJobId, resultNo: 1, revisionNo: 1, jobVersion: 3,
    jobName: `Ванна ${cutResultId}`, sourceDisplayNumber: null,
    placements: [
      { orderId: 2979, detailId: 1, detailNumber: 1, quantity: 2, laminatedOrLater: false, productionRound: 1 },
      { orderId: 2979, detailId: 2, detailNumber: 2, quantity: 1, laminatedOrLater: false, productionRound: 1 },
    ],
    composition: [
      { orderId: 2979, detailId: 1, hdfDetailId: null, quantity: 2 },
      { orderId: 2979, detailId: 2, hdfDetailId: null, quantity: 1 },
    ],
    manualColumn: null, otherLinkedCards: 0,
    ...patch,
  };
}

const context = { scopeComplete: true, engineOwnsBoard: false, automaticColumn: 'baths' };

describe('bath duplicates: digest', () => {
  it('is the same from either side of the pair', () => {
    const old = bath(854);
    const next = bath(868);
    expect(pairDigest(old, next)).toBe(pairDigest(next, old));
    expect(pairDigest(old, next)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes with the job version or composition of either side and with a re-cut result', () => {
    const base = pairDigest(bath(854), bath(868));
    expect(pairDigest(bath(854, { jobVersion: 4 }), bath(868))).not.toBe(base);
    expect(pairDigest(bath(854), bath(868, { jobVersion: 4 }))).not.toBe(base);
    expect(pairDigest(bath(854, { composition: [...bath(854).composition,
      { orderId: 2979, detailId: 3, hdfDetailId: null, quantity: 1 }] }), bath(868))).not.toBe(base);
    expect(pairDigest(bath(854), bath(868, { revisionNo: 2 }))).not.toBe(base);
    expect(pairDigest(bath(854), bath(868, { placements: [bath(868).placements[0]] }))).not.toBe(base);
  });

  it('does not depend on composition row order', () => {
    const reversed = bath(854, { composition: [...bath(854).composition].reverse() });
    expect(pairDigest(reversed, bath(868))).toBe(pairDigest(bath(854), bath(868)));
  });
});

describe('bath duplicates: coverage', () => {
  it('is directed and counts quantities (10 vs 2 is not covered)', () => {
    const big = bath(854, { placements: [{ orderId: 1, detailId: 9, detailNumber: 9, quantity: 10,
      laminatedOrLater: false, productionRound: 1 }] });
    const small = bath(868, { placements: [{ orderId: 1, detailId: 9, detailNumber: 9, quantity: 2,
      laminatedOrLater: false, productionRound: 1 }] });
    expect(isCoveredBy(big, small)).toBe(false);
    expect(isCoveredBy(small, big)).toBe(true);
    expect(sharedDetails(big, small)).toEqual([{ orderId: 1, detailId: 9, detailNumber: 9, here: 10, there: 2 }]);
  });

  it('needs every detail of this bath in the other one', () => {
    const extra = bath(854, { placements: [...bath(854).placements,
      { orderId: 2979, detailId: 5, detailNumber: 5, quantity: 1, laminatedOrLater: false, productionRound: 1 }] });
    expect(isCoveredBy(extra, bath(868))).toBe(false);
    expect(isCoveredBy(bath(868), extra)).toBe(true);
  });
});

describe('bath duplicates: archive hint', () => {
  it('is archivable only when covered, without production, with the whole job composition placed there', () => {
    expect(archiveHint(bath(854), bath(868), context)).toEqual({ archivable: true, blockedReason: null });
  });

  it('never gives the hint under the engine or with a partial scope', () => {
    expect(archiveHint(bath(854), bath(868), { ...context, engineOwnsBoard: true }))
      .toEqual({ archivable: false, blockedReason: 'engine' });
    expect(archiveHint(bath(854), bath(868), { ...context, scopeComplete: false }))
      .toEqual({ archivable: false, blockedReason: 'scope' });
  });

  it('treats laminated columns (auto or manual), laminated details and an opened rework as production', () => {
    for (const automaticColumn of ['baths_laminated', 'completed_baths']) {
      expect(archiveHint(bath(854), bath(868), { ...context, automaticColumn }).blockedReason).toBe('production');
    }
    for (const manualColumn of ['baths_laminated', 'completed_baths']) {
      expect(archiveHint(bath(854, { manualColumn }), bath(868), context).blockedReason).toBe('production');
    }
    const placements = bath(854).placements;
    expect(archiveHint(bath(854, { placements: [{ ...placements[0], laminatedOrLater: true }, placements[1]] }),
      bath(868), context).blockedReason).toBe('production');
    expect(archiveHint(bath(854, { placements: [{ ...placements[0], productionRound: 2 }, placements[1]] }),
      bath(868), context).blockedReason).toBe('production');
    expect(archiveHint(bath(854, { manualColumn: 'baths_ready' }), bath(868), context).archivable).toBe(true);
  });

  it('is off when the job has an HDF, unplaced or larger item the other bath does not cover', () => {
    const composition = bath(854).composition;
    expect(archiveHint(bath(854, { composition: [...composition, { orderId: 2979, detailId: null, hdfDetailId: 77,
      quantity: 1 }] }), bath(868), context).blockedReason).toBe('composition');
    expect(archiveHint(bath(854, { composition: [...composition, { orderId: 2979, detailId: 3, hdfDetailId: null,
      quantity: 1 }] }), bath(868), context).blockedReason).toBe('composition');
    expect(archiveHint(bath(854, { composition: [{ ...composition[0], quantity: 3 }, composition[1]] }), bath(868),
      context).blockedReason).toBe('composition');
  });

  it('allows only the own bath_seed among linked cards', () => {
    expect(archiveHint(bath(854, { otherLinkedCards: 1 }), bath(868), context))
      .toEqual({ archivable: false, blockedReason: 'linked_cards' });
  });

  it('reports not_covered before production', () => {
    const big = bath(854, { placements: bath(854).placements.map(p => ({ ...p, quantity: 5, laminatedOrLater: true })) });
    expect(archiveHint(big, bath(868), context).blockedReason).toBe('not_covered');
  });
});

describe('bath duplicates: board entries', () => {
  const facts = new Map([[bath(854).bathCardId, bath(854)], [bath(868).bathCardId, bath(868)],
    ['cut-result:900', bath(900, { placements: [{ orderId: 50, detailId: 90, detailNumber: 1, quantity: 1,
      laminatedOrLater: false, productionRound: 1 }] })]]);
  const shown = [{ bathCardId: 'cut-result:854', column: 'baths' }, { bathCardId: 'cut-result:868', column: 'baths' }];
  const digest = pairDigest(bath(854), bath(868));

  it('pairs only baths sharing details and gives the same digest on both cards', () => {
    const result = buildBathDuplicates({ shown, facts, resolutions: [], visibleOrderIds: new Set([2979, 50]),
      engineOwnsBoard: false });
    const old = result.get('cut-result:854')!.duplicates;
    const next = result.get('cut-result:868')!.duplicates;
    expect(old).toHaveLength(1);
    expect(old[0]).toMatchObject({ otherBathCardId: 'cut-result:868', otherJobLabel: 'Раскрой №11 · Ванна 868',
      sharedCount: 2, coveredBy: true, archivable: true, blockedReason: null, resolvedAction: null });
    expect(next[0].digest).toBe(old[0].digest);
    expect(old[0].digest).toBe(digest);
  });

  it('hides a pair decided «keep both» while the digest is the same, and shows it again after a change', () => {
    const resolutions = [{ bathA: 'cut-result:854', bathB: 'cut-result:868', targetBath: 'cut-result:868',
      action: 'keep_both' as const, digest }];
    const hidden = buildBathDuplicates({ shown, facts, resolutions, visibleOrderIds: new Set([2979]),
      engineOwnsBoard: false });
    expect(hidden.has('cut-result:854')).toBe(false);
    const changed = new Map(facts);
    changed.set('cut-result:868', bath(868, { jobVersion: 9 }));
    const again = buildBathDuplicates({ shown, facts: changed, resolutions, visibleOrderIds: new Set([2979]),
      engineOwnsBoard: false });
    expect(again.get('cut-result:854')!.duplicates).toHaveLength(1);
  });

  it('puts a rework mark on its target bath only (either pair order)', () => {
    for (const targetBath of ['cut-result:854', 'cut-result:868']) {
      const resolutions = [{ bathA: 'cut-result:854', bathB: 'cut-result:868', targetBath, action: 'rework_mark' as const,
        digest }];
      const result = buildBathDuplicates({ shown, facts, resolutions, visibleOrderIds: new Set([2979]),
        engineOwnsBoard: false });
      const other = targetBath === 'cut-result:854' ? 'cut-result:868' : 'cut-result:854';
      expect(result.get(targetBath)!.reworkMarks).toEqual([{ otherBathCardId: other, detailCount: 2 }]);
      expect(result.get(other)!.reworkMarks).toEqual([]);
      expect(result.get(other)!.duplicates[0].resolvedAction).toBe('rework_mark');
    }
  });

  it('counts distinct marked details over overlapping and disjoint marked pairs', () => {
    const detail = (detailId: number) => ({ orderId: 2979, detailId, detailNumber: detailId, quantity: 1,
      laminatedOrLater: false, productionRound: 1 });
    const a = bath(854, { placements: [1, 2, 3, 4].map(detail) });
    const b = bath(868, { placements: [1, 2].map(detail) });
    const c = bath(900, { placements: [3, 4].map(detail) });
    const d = bath(901, { placements: [2, 3].map(detail) });
    const mark = (other: MdfBathSideFacts) => ({ bathA: a.bathCardId, bathB: other.bathCardId, targetBath: a.bathCardId,
      action: 'rework_mark' as const, digest: pairDigest(a, other) });
    const run = (others: MdfBathSideFacts[]) => buildBathDuplicates({ shown: [{ bathCardId: a.bathCardId, column: 'baths' }],
      facts: new Map([a, ...others].map(x => [x.bathCardId, x])), resolutions: others.map(mark),
      visibleOrderIds: new Set([2979]), engineOwnsBoard: false }).get(a.bathCardId)!;
    // A–B {1,2} and A–C {3,4}: four distinct details, two pairs of two.
    const disjoint = run([b, c]);
    expect(disjoint.reworkMarks.map(m => m.detailCount)).toEqual([2, 2]);
    expect(disjoint.reworkDetailCount).toBe(4);
    // A–B {1,2} and A–D {2,3}: detail 2 counted once.
    expect(run([b, d]).reworkDetailCount).toBe(3);
  });

  it('redacts the other bath when one of its orders is out of scope', () => {
    const wide = new Map(facts);
    wide.set('cut-result:868', bath(868, { placements: [...bath(868).placements,
      { orderId: 3000, detailId: 7, detailNumber: 1, quantity: 1, laminatedOrLater: false, productionRound: 1 }] }));
    const entry = buildBathDuplicates({ shown, facts: wide, resolutions: [], visibleOrderIds: new Set([2979]),
      engineOwnsBoard: false }).get('cut-result:854')!.duplicates[0];
    expect(entry).toMatchObject({ otherJobLabel: null, archivable: false, blockedReason: 'scope', sharedCount: 2 });
    expect(entry.shared.map(s => s.orderId)).toEqual([2979, 2979]);
  });

  it('redacts by every owner of the other bath, also one with HDF placements only', () => {
    const hdfOwner = new Map(facts);
    hdfOwner.set('cut-result:868', bath(868, { ownerOrderIds: [2979, 4000] }));
    const entry = buildBathDuplicates({ shown, facts: hdfOwner, resolutions: [], visibleOrderIds: new Set([2979]),
      engineOwnsBoard: false }).get('cut-result:854')!.duplicates[0];
    expect(entry).toMatchObject({ otherJobLabel: null, archivable: false, blockedReason: 'scope', sharedCount: 2 });
  });

  it('gives the engine reason when the engine owns the board', () => {
    const entry = buildBathDuplicates({ shown, facts, resolutions: [], visibleOrderIds: new Set([2979]),
      engineOwnsBoard: true }).get('cut-result:854')!.duplicates[0];
    expect(entry).toMatchObject({ archivable: false, blockedReason: 'engine' });
  });

  it('parses only bath card ids', () => {
    expect(parseBathCardId('cut-result:42')).toBe(42);
    expect(parseBathCardId('cut-result:0')).toBeNull();
    expect(parseBathCardId('packet:42')).toBeNull();
  });
});

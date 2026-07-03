import { describe, expect, it } from 'vitest';
import { SCAN_FIELD_WEIGHTS, rankCandidates, scoreCandidate } from './scan-ranking';

describe('scoreCandidate', () => {
  it('sums known weights, ignores unknown tags', () => {
    expect(scoreCandidate(['detail_id'])).toBe(SCAN_FIELD_WEIGHTS.detail_id);
    expect(scoreCandidate(['order_name', 'detail_number'])).toBe(
      SCAN_FIELD_WEIGHTS.order_name + SCAN_FIELD_WEIGHTS.detail_number,
    );
    expect(scoreCandidate(['unknown'])).toBe(0);
  });
});

describe('rankCandidates', () => {
  const c = (score: number, detailId = 0) => ({ score, detailId });
  it('sorts desc, applies min score and limit', () => {
    const out = rankCandidates([c(4), c(12), c(1), c(7)]);
    expect(out.map((x) => x.score)).toEqual([12, 7, 4]); // 1 < minScore(3) отрезан
  });
  it('respects custom limit', () => {
    const out = rankCandidates([c(5), c(6), c(7)], { limit: 2 });
    expect(out.map((x) => x.score)).toEqual([7, 6]);
  });
  it('deterministic tiebreak by detailId on equal score', () => {
    const out = rankCandidates([c(5, 900), c(5, 100), c(5, 500)]);
    expect(out.map((x) => x.detailId)).toEqual([100, 500, 900]);
  });
  it('renamed-order scenario: snapshot hit outranks stale live name', () => {
    expect(scoreCandidate(['snapshot', 'detail_number'])).toBeGreaterThan(
      scoreCandidate(['order_name', 'detail_number']),
    );
  });
});

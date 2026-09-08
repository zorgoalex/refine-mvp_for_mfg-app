import { describe, expect, it } from 'vitest';
import { svgUploadOrderNames } from './svgUploadOrderNames';

describe('SVG upload source order scope', () => {
  it('includes order2900 from numeric source pieces even when the filename omits it', () => {
    expect(svgUploadOrderNames([
      { orderName: '2900', detailNumber: 3 },
      { orderName: '2895', detailNumber: 1 },
      { orderName: '2900', detailNumber: 3 },
      { orderName: 'visual only', detailNumber: null },
    ], ['2895', '2887'])).toEqual(['2900', '2895', '2887']);
  });
  it('keeps unknown source names for explicit lookup warnings, without inventing an ID', () => {
    expect(svgUploadOrderNames([{ orderName: ' E2E-missing ', detailNumber: 3 }], [])).toEqual(['E2E-missing']);
  });
});

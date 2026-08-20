import { afterEach, describe, expect, it, vi } from 'vitest';
import { CUT_RENDER_STYLE_MDF_BOARD_PREVIEW } from '@shared/cut-render-style';
import { cutApi } from '../../api/cutApi';
import {
  decorateCncMdfBoardSheetSvg,
  fetchCncMdfBoardSheetSvg,
} from './cncMdfSheetPreview';

describe('fetchCncMdfBoardSheetSvg', () => {
  afterEach(() => vi.restoreAllMocks());

  it('always requests the MDF board render style', async () => {
    const fetchSheetSvg = vi.spyOn(cutApi, 'fetchSheetSvg').mockResolvedValue(
      new Blob(['<svg/>'], { type: 'image/svg+xml' }),
    );

    await fetchCncMdfBoardSheetSvg({
      cutJobId: 42,
      cutGroupId: 100,
      sheetIndex: 2,
      landscape: true,
      variant: 'manual',
      renderToken: 'result-42-3',
      originTopLeft: false,
      axisOrigin: 'bottom-left',
      resultNo: 3,
      pieceMetadata: true,
    });

    expect(fetchSheetSvg).toHaveBeenCalledWith(
      42,
      100,
      2,
      true,
      'manual',
      'result-42-3',
      false,
      'bottom-left',
      3,
      true,
      CUT_RENDER_STYLE_MDF_BOARD_PREVIEW,
    );
  });

  it('adds the cut job number when the backend returns an undecorated SVG', async () => {
    vi.spyOn(cutApi, 'fetchSheetSvg').mockResolvedValue(
      new Blob([
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 2000">',
        '<rect width="1000" height="2000" fill="#ffffff"/>',
        '<text><tspan font-size="48">2817</tspan></text>',
        '</svg>',
      ], { type: 'image/svg+xml' }),
    );

    const blob = await fetchCncMdfBoardSheetSvg({
      cutJobId: 150,
      cutGroupId: 100,
      sheetIndex: 0,
      cutJobDisplayNumber: '150',
    });
    const svg = await blob.text();

    expect(svg).toContain('class="cut-sheet-job-heading"');
    expect(svg).toContain('Раскрой №150');
    expect(svg).toContain('font-size="55"');
    expect(svg).toContain('viewBox="0 -104.5 1000 2104.5"');
  });

  it('does not duplicate a heading already returned by the backend', () => {
    const svg = '<svg viewBox="0 0 100 200"><text class="cut-sheet-job-heading">Раскрой №150</text></svg>';

    expect(decorateCncMdfBoardSheetSvg(svg, '150')).toBe(svg);
  });
});

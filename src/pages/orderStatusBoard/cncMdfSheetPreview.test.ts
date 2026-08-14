import { afterEach, describe, expect, it, vi } from 'vitest';
import { CUT_RENDER_STYLE_MDF_BOARD_PREVIEW } from '@shared/cut-render-style';
import { cutApi } from '../../api/cutApi';
import { fetchCncMdfBoardSheetSvg } from './cncMdfSheetPreview';

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
});

import { CUT_RENDER_STYLE_MDF_BOARD_PREVIEW } from '@shared/cut-render-style';
import { cutApi } from '../../api/cutApi';

export interface FetchCncMdfBoardSheetSvgOptions {
  cutJobId: number;
  cutGroupId: number;
  sheetIndex: number;
  landscape?: boolean;
  variant?: 'auto' | 'manual' | 'active';
  renderToken?: string;
  originTopLeft?: boolean;
  axisOrigin?: 'top-left' | 'bottom-left';
  resultNo?: number;
  pieceMetadata?: boolean;
}

export function fetchCncMdfBoardSheetSvg(options: FetchCncMdfBoardSheetSvgOptions): Promise<Blob> {
  return cutApi.fetchSheetSvg(
    options.cutJobId,
    options.cutGroupId,
    options.sheetIndex,
    options.landscape ?? false,
    options.variant,
    options.renderToken,
    options.originTopLeft ?? true,
    options.axisOrigin ?? 'top-left',
    options.resultNo,
    options.pieceMetadata ?? false,
    CUT_RENDER_STYLE_MDF_BOARD_PREVIEW,
  );
}

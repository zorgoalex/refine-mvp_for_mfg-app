import {
  CUT_RENDER_STYLE_MDF_BOARD_PREVIEW,
  resolveCutRenderStyleFromSetting,
  type CutRenderStylesSetting,
} from '@shared/cut-render-style';
import { buildManualSvgSheetSvg } from '../../../backend/src/modules/cut/render/sheet-svg';
import type { CncTelegramCutLayout } from '../../api/types/cncTelegramApi.types';
import type { ParsedSvgUpload } from './svgCutUploadParser';

export function createStyledSvgUploadPreviewBlob(
  parsed: ParsedSvgUpload,
  renderStylesSetting?: CutRenderStylesSetting | null,
): Blob | null {
  const svg = buildStyledSvgUploadPreview(parsed, renderStylesSetting);
  return svg ? new Blob([svg], { type: 'image/svg+xml' }) : null;
}

export function buildStyledSvgUploadPreview(
  parsed: ParsedSvgUpload,
  renderStylesSetting?: CutRenderStylesSetting | null,
): string | null {
  return buildStyledCutLayoutPreview(parsed.cutLayout, renderStylesSetting);
}

export function buildStyledCutLayoutPreview(
  layout: CncTelegramCutLayout,
  renderStylesSetting?: CutRenderStylesSetting | null,
): string | null {
  const renderStyle = resolveCutRenderStyleFromSetting(
    CUT_RENDER_STYLE_MDF_BOARD_PREVIEW,
    renderStylesSetting,
  );
  return buildManualSvgSheetSvg(layout, renderStyle);
}

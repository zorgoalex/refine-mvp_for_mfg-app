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
  cutJobDisplayNumber?: string | number | null;
}

function svgNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function decorateCncMdfBoardSheetSvg(
  svg: string,
  cutJobDisplayNumber: string | number | null | undefined,
): string {
  const displayNumber = cutJobDisplayNumber == null ? '' : String(cutJobDisplayNumber).trim();
  if (!displayNumber || svg.includes('class="cut-sheet-job-heading"')) return svg;

  const viewBoxMatch = svg.match(/<svg\b[^>]*\bviewBox=(["'])([^"']+)\1[^>]*>/);
  const values = viewBoxMatch?.[2]?.trim().split(/[\s,]+/).map(Number) ?? [];
  const [viewX, viewY, viewWidth, viewHeight] = values;
  if (
    values.length !== 4
    || ![viewX, viewY, viewWidth, viewHeight].every((value) => Number.isFinite(value))
    || viewWidth <= 0
    || viewHeight <= 0
  ) {
    return svg;
  }

  const pieceLabelFont = [...svg.matchAll(/<tspan\b[^>]*\bfont-size=(["'])([^"']+)\1/g)]
    .map((match) => Number(match[2]))
    .filter((value) => Number.isFinite(value) && value > 0)
    .reduce((largest, value) => Math.max(largest, value), 0);
  const declaredOrderFont = Number(svg.match(/\bdata-cut-order-label-font-mm=(["'])([^"']+)\1/)?.[2]);
  const sheetBackground = svg.match(/<rect\b[^>]*\bfill=(["'])([^"']+)\1/)?.[2] ?? '#ffffff';
  const minimumHeadingFont = Math.max(
    24,
    Math.round(Math.min(viewWidth, viewHeight) / 40),
    pieceLabelFont,
    Number.isFinite(declaredOrderFont) ? declaredOrderFont : 0,
  );
  const headingFont = Math.round(minimumHeadingFont * 1.15);
  const headingHeight = headingFont * 1.9;
  const headingViewY = viewY - headingHeight;
  const headingCenterY = viewY - headingHeight / 2;
  const headingCenterX = viewX + viewWidth / 2;
  const escapedDisplayNumber = escapeSvgText(displayNumber.replace(/^[№#]\s*/, ''));
  const decoratedViewBox = [
    svgNumber(viewX),
    svgNumber(headingViewY),
    svgNumber(viewWidth),
    svgNumber(viewHeight + headingHeight),
  ].join(' ');
  const decorated = svg.replace(
    /(<svg\b[^>]*\bviewBox=)(["'])[^"']*\2/,
    (_match, prefix: string, quote: string) => `${prefix}${quote}${decoratedViewBox}${quote}`,
  );
  const heading = [
    `<rect class="cut-sheet-job-heading-background" x="${svgNumber(viewX)}" y="${svgNumber(headingViewY)}" width="${svgNumber(viewWidth)}" height="${svgNumber(headingHeight)}" fill="${sheetBackground}"/>`,
    `<text class="cut-sheet-job-heading" data-cut-job-heading="${escapedDisplayNumber}" x="${svgNumber(headingCenterX)}" y="${svgNumber(headingCenterY)}" font-family="Liberation Sans, sans-serif" font-size="${svgNumber(headingFont)}" font-weight="400" fill="#111827" text-anchor="middle" dominant-baseline="middle">Раскрой №${escapedDisplayNumber}</text>`,
  ].join('');
  return decorated.replace(/(<svg\b[^>]*>)/, `$1${heading}`);
}

export async function fetchCncMdfBoardSheetSvg(options: FetchCncMdfBoardSheetSvgOptions): Promise<Blob> {
  const blob = await cutApi.fetchSheetSvg(
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
  if (options.cutJobDisplayNumber == null) return blob;

  const svg = await blob.text();
  const decorated = decorateCncMdfBoardSheetSvg(svg, options.cutJobDisplayNumber);
  return decorated === svg
    ? blob
    : new Blob([decorated], { type: blob.type || 'image/svg+xml' });
}

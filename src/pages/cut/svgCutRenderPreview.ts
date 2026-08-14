import {
  CUT_RENDER_STYLE_MDF_BOARD_PREVIEW,
  cutRenderLabelFillForBackground,
  cutRenderLabelStrokeForBackground,
  cutRenderOrderFillPalette,
  cutRenderSourceSvgCss,
  resolveCutRenderStyleFromSetting,
  type CutRenderStylesSetting,
} from '@shared/cut-render-style';
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
  const sheet = parsed.cutLayout.sheet;
  if (!sheet || parsed.cutLayout.items.length === 0) return null;
  const style = resolveCutRenderStyleFromSetting(CUT_RENDER_STYLE_MDF_BOARD_PREVIEW, renderStylesSetting);
  const palette = cutRenderOrderFillPalette(style);
  const orderIndexByName = new Map<string, number>();
  const fontMm = Math.max(24, Math.round(Math.min(sheet.widthMm, sheet.heightMm) / 40));
  const sourceCss = cutRenderSourceSvgCss(style);
  const pieces = parsed.cutLayout.items.map((item) => {
    const fill = fillForOrderName(item.orderName, orderIndexByName, palette, style.piece.defaultFill);
    const cx = item.xMm + item.placedWidthMm / 2;
    const cy = item.yMm + item.placedHeightMm / 2;
    const rect = `<rect x="${num(item.xMm)}" y="${num(item.yMm)}" width="${num(item.placedWidthMm)}" height="${num(
      item.placedHeightMm,
    )}" fill="${escapeXml(fill)}" stroke="${style.piece.stroke}" stroke-width="${num(style.piece.strokeWidthMm)}"/>`;
    const sourceSvg = renderSourceSvg(item.sourceSvg, item.xMm, item.yMm, item.placedWidthMm, item.placedHeightMm, sourceCss);
    const lines = [
      item.orderName,
      `поз. ${item.detailNumber}`,
      `${formatDimension(item.widthMm)}X${formatDimension(item.heightMm)}`,
    ];
    const labelFill = cutRenderLabelFillForBackground(fill, style);
    const labelStroke = cutRenderLabelStrokeForBackground(fill, fontMm, style);
    const labelStrokeAttrs = labelStroke
      ? ` stroke="${labelStroke.stroke}" stroke-width="${num(labelStroke.strokeWidthMm)}" paint-order="stroke"`
      : '';
    const tspans = lines.map((line, index) => {
      const dy = index === 0 ? `${(-(lines.length - 1) / 2).toFixed(3)}em` : '1em';
      return `<tspan x="${num(cx)}" dy="${dy}">${escapeXml(line)}</tspan>`;
    }).join('');
    const text = `<text x="${num(cx)}" y="${num(cy)}" font-family="Liberation Sans, Arial, sans-serif" font-size="${num(
      fontMm,
    )}" fill="${labelFill}"${labelStrokeAttrs} text-anchor="middle" dominant-baseline="middle">${tspans}</text>`;
    return `<g>${rect}${sourceSvg}${text}</g>`;
  }).join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(sheet.widthMm)} ${num(sheet.heightMm)}">`,
    `<rect x="0" y="0" width="${num(sheet.widthMm)}" height="${num(sheet.heightMm)}" fill="#ffffff" stroke="#9aa7b4" stroke-width="3"/>`,
    pieces,
    '</svg>',
  ].join('');
}

function fillForOrderName(
  orderName: string,
  orderIndexByName: Map<string, number>,
  palette: readonly string[],
  fallback: string,
): string {
  const key = orderName.trim();
  if (!key) return fallback;
  let index = orderIndexByName.get(key);
  if (index === undefined) {
    index = orderIndexByName.size;
    orderIndexByName.set(key, index);
  }
  return palette[index % palette.length] ?? fallback;
}

function renderSourceSvg(
  sourceSvg: ParsedSvgUpload['cutLayout']['items'][number]['sourceSvg'],
  x: number,
  y: number,
  width: number,
  height: number,
  css: string,
): string {
  if (!sourceSvg?.body.trim()) return '';
  return [
    `<svg class="cut-sheet-piece-source-svg" x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(
      sourceSvg.viewBox.widthMm,
    )} ${num(sourceSvg.viewBox.heightMm)}" preserveAspectRatio="none" overflow="hidden">`,
    css ? `<style>${css}</style>` : '',
    sourceSvg.body,
    '</svg>',
  ].join('');
}

function formatDimension(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

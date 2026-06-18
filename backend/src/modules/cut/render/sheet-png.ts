import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

/**
 * Per-sheet PNG rasterization (plan §7). resvg-js (pure-rust prebuilt binary, no
 * headless browser). Bundled TTF is loaded from disk into a buffer (NOT a system
 * path) so the container has no font dependency; a startup assert fails fast if
 * the font is missing (resvg silently drops <text> otherwise — MINOR-16).
 */
export const FONT_FAMILY = 'Liberation Sans';
const FONT_FILE = 'LiberationSans-Regular.ttf';

// Longest-side caps in px (plan §7).
export const RENDER_PRESETS = {
  thumb: 360,
  screen: 1400,
  print: 3500,
} as const;

export type RenderPreset = keyof typeof RENDER_PRESETS;

// Candidate locations for the bundled font. __dirname is .../{src|dist}/modules/cut/render;
// the package root (holding assets/) is four levels up in both test and built layouts.
function fontCandidates(): string[] {
  return [
    resolve(__dirname, '../../../../assets/fonts', FONT_FILE),
    join(process.cwd(), 'assets/fonts', FONT_FILE),
    join(process.cwd(), 'backend/assets/fonts', FONT_FILE),
  ];
}

export function resolveFontPath(): string | null {
  return fontCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

/** Startup fail-fast: resvg renders blank text if the font is absent. */
export function assertFontAvailable(): void {
  if (!resolveFontPath()) {
    throw new Error(
      `Cut render font ${FONT_FILE} not found. Looked in: ${fontCandidates().join(', ')}. ` +
        'Ensure the Dockerfile COPY includes assets/.',
    );
  }
}

let cachedFontPath: string | null = null;

function requireFontPath(): string {
  if (!cachedFontPath) {
    assertFontAvailable();
    cachedFontPath = resolveFontPath() as string;
  }
  return cachedFontPath;
}

export interface RenderSheetPngInput {
  svg: string;
  /** longest-side cap in px (resolved from cut_render_presets config, not a literal) */
  targetPx: number;
  sheetWidthMm: number;
  sheetHeightMm: number;
}

export function renderSheetPng(input: RenderSheetPngInput): Buffer {
  const px = input.targetPx;
  // Cap the LONGEST side to the preset px (landscape -> width, portrait -> height).
  const fitTo =
    input.sheetWidthMm >= input.sheetHeightMm
      ? ({ mode: 'width', value: px } as const)
      : ({ mode: 'height', value: px } as const);

  // NOTE: resvg-js 2.6.2 honors fitTo only with fontFiles (a fontBuffers +
  // fitTo bug renders at intrinsic size). We load the bundled TTF by path with
  // loadSystemFonts:false, so there is still no system-font dependency.
  const resvg = new Resvg(input.svg, {
    fitTo,
    font: {
      fontFiles: [requireFontPath()],
      defaultFontFamily: FONT_FAMILY,
      loadSystemFonts: false,
    },
  });
  return Buffer.from(resvg.render().asPng());
}

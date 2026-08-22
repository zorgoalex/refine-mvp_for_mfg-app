import { describe, expect, it } from 'vitest';
import {
  CUT_RENDER_STYLE_MDF_BOARD_PREVIEW,
  DEFAULT_CUT_RENDER_STYLES_SETTING,
  cutRenderSourceSvgCss,
  resolveCutRenderStyleFromSetting,
} from '@shared/cut-render-style';
import { buildStyledSvgUploadPreview } from './svgCutRenderPreview';
import type { ParsedSvgUpload } from './svgCutUploadParser';

describe('buildStyledSvgUploadPreview', () => {
  it('renders one sheet background and uses each order color for its contour and milling lines', () => {
    const svg = buildStyledSvgUploadPreview(parsedUpload());
    const rendered = svg ?? '';

    expect(svg).not.toBeNull();
    expect(rendered).toContain('fill="#ffffff" stroke="#d7e9ff"');
    expect(rendered).toContain('fill="#ffffff" stroke="#dff3d7"');
    expect(rendered).not.toContain('fill="#d7e9ff"');
    expect(rendered).not.toContain('fill="#dff3d7"');
    expect(rendered).toContain(cutRenderSourceSvgCss(CUT_RENDER_STYLE_MDF_BOARD_PREVIEW, '#ffffff', '#d7e9ff', '.cut-sheet-piece-source-svg-0'));
    expect(rendered).toContain(cutRenderSourceSvgCss(CUT_RENDER_STYLE_MDF_BOARD_PREVIEW, '#ffffff', '#dff3d7', '.cut-sheet-piece-source-svg-1'));
    expect(rendered).toContain('class="cut-sheet-piece-source-svg cut-sheet-piece-source-svg-0"');
    expect(rendered).toContain('class="cut-sheet-piece-source-svg cut-sheet-piece-source-svg-1"');
    expect(rendered).not.toContain('<style>.cut-sheet-piece-source-svg *{');
    expect(rendered).not.toContain('<style>*{');
    expect(rendered).toContain('fill="#111827" stroke="#ffffff"');
    expect(rendered).toContain('font-weight="800"');
    expect(rendered).toContain('>2723</tspan>');
    expect(rendered).toContain('>2724</tspan>');
    expect(rendered).toContain('># 01</tspan>');
    expect(rendered).toContain('>300*200</tspan>');
    expect(rendered).toContain('># 2</tspan>');
    expect(rendered).not.toContain('>МДФ 18</tspan>');
    expect(rendered).not.toContain('поз.');
    expect(rendered).not.toContain('300X200');
    const geometryLayer = rendered.indexOf('class="cut-sheet-piece-geometry-layer"');
    const labelLayer = rendered.indexOf('class="cut-sheet-piece-label-layer"');
    expect(geometryLayer).toBeGreaterThan(-1);
    expect(labelLayer).toBeGreaterThan(geometryLayer);
    expect(rendered.lastIndexOf('cut-sheet-piece-source-svg')).toBeLessThan(labelLayer);
    expect(rendered.indexOf('>2723</tspan>')).toBeGreaterThan(labelLayer);
    expect(rendered.indexOf('>2724</tspan>')).toBeGreaterThan(labelLayer);
  });

  it('uses custom render.styles values in the local upload preview', () => {
    const setting = {
      ...DEFAULT_CUT_RENDER_STYLES_SETTING,
      templates: undefined,
      profiles: {
        ...DEFAULT_CUT_RENDER_STYLES_SETTING.profiles,
        mdf_board_preview: {
          ...DEFAULT_CUT_RENDER_STYLES_SETTING.profiles.mdf_board_preview,
          piece: {
            ...DEFAULT_CUT_RENDER_STYLES_SETTING.profiles.mdf_board_preview.piece,
            stroke: '#654321',
            strokeWidthMm: 4,
            orderPalette: ['#111827', '#e5e7eb'],
          },
          label: {
            ...DEFAULT_CUT_RENDER_STYLES_SETTING.profiles.mdf_board_preview.label,
            lightFill: '#fefefe',
            lightTextStroke: '#222222',
            orderFontRatio: 1.2,
            positionFontRatio: 0.4,
            sizeFontRatio: 0.7,
            orderPositionGapRatio: 0.2,
            positionSizeGapRatio: 0.3,
            letterSpacingRatio: -0.1,
          },
          sourceSvg: {
            ...DEFAULT_CUT_RENDER_STYLES_SETTING.profiles.mdf_board_preview.sourceSvg,
            minStrokePx: 3.5,
            nonScalingStroke: false,
          },
        },
      },
    };
    const style = resolveCutRenderStyleFromSetting(CUT_RENDER_STYLE_MDF_BOARD_PREVIEW, setting);
    const rendered = buildStyledSvgUploadPreview(parsedUpload(), setting) ?? '';

    expect(rendered).toContain('fill="#ffffff" stroke="#111827" stroke-width="4"');
    expect(rendered).toContain('fill="#ffffff" stroke="#e5e7eb" stroke-width="4"');
    expect(rendered).not.toMatch(/<rect[^>]*fill="#111827"/);
    expect(rendered).not.toMatch(/<rect[^>]*fill="#e5e7eb"/);
    expect(rendered).toContain(cutRenderSourceSvgCss(style, '#ffffff', '#111827', '.cut-sheet-piece-source-svg-0'));
    expect(rendered).toContain(cutRenderSourceSvgCss(style, '#ffffff', '#e5e7eb', '.cut-sheet-piece-source-svg-1'));
    expect(rendered).not.toContain('vector-effect:non-scaling-stroke!important');
    expect(rendered).toContain('fill="#111827" stroke="#ffffff"');
    expect(rendered).toContain('letter-spacing="-2.4"');
    expect(rendered).toContain('font-size="28.8">2723</tspan>');
    expect(rendered).toContain('font-size="9.6"># 01</tspan>');
    expect(rendered).toContain('font-size="16.8">300*200</tspan>');
  });
});

function parsedUpload(): ParsedSvgUpload {
  return {
    fileName: 'CNC#1_2723+2724.svg',
    svgContentHash: 'a'.repeat(64),
    cutLayout: {
      status: 'valid',
      reasons: [],
      sheet: { widthMm: 1000, heightMm: 800 },
      items: [
        {
          orderName: '2723',
          detailNumber: 1,
          widthMm: 300,
          heightMm: 200,
          quantity: 1,
          xMm: 10,
          yMm: 20,
          placedWidthMm: 300,
          placedHeightMm: 200,
          rotated: false,
          sourceSvg: {
            viewBox: { xMm: 0, yMm: 0, widthMm: 300, heightMm: 200 },
            body: '<line x1="0" y1="0" x2="300" y2="200" stroke="#626769" stroke-width="0.5"/>',
          },
          visualLabel: { rawLines: ['2723', '# 01', '300*200', 'МДФ 18'] },
        },
        {
          orderName: '2724',
          detailNumber: 2,
          widthMm: 300,
          heightMm: 200,
          quantity: 1,
          xMm: 320,
          yMm: 20,
          placedWidthMm: 300,
          placedHeightMm: 200,
          rotated: false,
          sourceSvg: {
            viewBox: { xMm: 0, yMm: 0, widthMm: 300, heightMm: 200 },
            body: '<path d="M10 100 H290" stroke="#626769" stroke-width="0.5"/>',
          },
        },
      ],
    },
    items: [],
  };
}

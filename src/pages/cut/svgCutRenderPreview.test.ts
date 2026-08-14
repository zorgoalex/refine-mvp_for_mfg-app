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
  it('renders order-colored pieces, source geometry, and labels with the MDF preview profile', () => {
    const svg = buildStyledSvgUploadPreview(parsedUpload());
    const rendered = svg ?? '';

    expect(svg).not.toBeNull();
    expect(rendered).toContain('fill="#d7e9ff"');
    expect(rendered).toContain('fill="#dff3d7"');
    expect(rendered).toContain(cutRenderSourceSvgCss(CUT_RENDER_STYLE_MDF_BOARD_PREVIEW));
    expect(rendered).toContain('>2723</tspan>');
    expect(rendered).toContain('>2724</tspan>');
    expect(rendered.indexOf('cut-sheet-piece-source-svg')).toBeLessThan(rendered.indexOf('>2723</tspan>'));
  });

  it('uses custom render.styles values in the local upload preview', () => {
    const setting = {
      ...DEFAULT_CUT_RENDER_STYLES_SETTING,
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
          },
          sourceSvg: {
            minStrokePx: 3.5,
            nonScalingStroke: false,
          },
        },
      },
    };
    const style = resolveCutRenderStyleFromSetting(CUT_RENDER_STYLE_MDF_BOARD_PREVIEW, setting);
    const rendered = buildStyledSvgUploadPreview(parsedUpload(), setting) ?? '';

    expect(rendered).toContain('fill="#111827"');
    expect(rendered).toContain('stroke="#654321" stroke-width="4"');
    expect(rendered).toContain(cutRenderSourceSvgCss(style));
    expect(rendered).not.toContain('vector-effect:non-scaling-stroke!important');
    expect(rendered).toContain('fill="#fefefe" stroke="#222222"');
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
          sourceSvg: null,
        },
      ],
    },
    items: [],
  };
}

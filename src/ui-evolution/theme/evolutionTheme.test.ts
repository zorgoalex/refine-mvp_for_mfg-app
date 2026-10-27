import { describe, expect, it } from 'vitest';
import { getModernUiTheme, WORKBENCH_FONT_FAMILY } from './evolutionTheme';

describe('modern UI themes', () => {
  it('keeps the shared typography and density for the pre-existing variants', () => {
    for (const variant of ['evolution', 'line', 'air', 'neutral'] as const) {
      for (const mode of ['light', 'dark'] as const) {
        const theme = getModernUiTheme(mode, variant);
        expect(theme.token).toMatchObject({
          controlHeight: 40,
          controlHeightSM: 32,
          controlHeightLG: 44,
          fontFamily: 'Inter, "Noto Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        });
        expect(theme.components?.Button).toMatchObject({ controlHeight: 40, fontWeight: 650 });
        expect(theme.components?.Table).toMatchObject({ cellPaddingBlock: 12, cellPaddingInline: 12 });
      }
    }
  });

  it('gives workbench its own font, denser controls and palette in both modes', () => {
    const light = getModernUiTheme('light', 'workbench');
    const dark = getModernUiTheme('dark', 'workbench');
    expect(light.token).toMatchObject({
      colorPrimary: '#2552D9',
      colorBgLayout: '#F2F4F7',
      controlHeight: 34,
      fontFamily: WORKBENCH_FONT_FAMILY,
    });
    expect(dark.token).toMatchObject({ colorBgLayout: '#0D1219', colorText: '#E6EAF1', controlHeight: 34 });
    expect(light.components?.Table).toMatchObject({ cellPaddingBlock: 9 });
  });
});

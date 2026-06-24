import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./CutPage.tsx', import.meta.url), 'utf8');

describe('CutPage sheet-variant selector wiring', () => {
  it('renders the sheet Select bound to setJobSheetMaterial', () => {
    expect(src).toMatch(/Лист раскроя/);
    expect(src).toMatch(/setJobSheetMaterial/);
    expect(src).toMatch(/cutApi\.setSheetMaterial/);
  });
  it('renders the mixed-material warning via the helper', () => {
    expect(src).toMatch(/isMixedMaterialSelection/);
    expect(src).toMatch(/раскроены на одном выбранном листе/);
  });
});

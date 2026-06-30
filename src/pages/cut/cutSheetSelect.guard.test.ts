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
  it('offers an explicit «Как у деталей» default option (null) to clear the override', () => {
    expect(src).toMatch(/value: null as number \| null, label: 'Как у деталей/);
    // anchored to the sheet Select's own clear path (not the global allowClear)
    expect(src).toMatch(/onChange=\{\(v\) => void setJobSheetMaterial\(v \?\? null\)\}/);
  });
  it('reads each detail material via the nested detail field (not a non-existent top-level field)', () => {
    expect(src).toMatch(/items\.map\([\s\S]*?detail\??\.sheetMaterialTypeId/);
  });
});

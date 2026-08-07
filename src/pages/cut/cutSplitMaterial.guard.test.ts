import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cutPage = readFileSync(new URL('./CutPage.tsx', import.meta.url), 'utf8');
const sheetPreview = readFileSync(new URL('./SheetPreview.tsx', import.meta.url), 'utf8');
const sheetEditor = readFileSync(new URL('./SheetEditor.tsx', import.meta.url), 'utf8');

describe('CutPage split-by-material toggle wiring', () => {
  it('renders the split Checkbox (default-driven by job.splitByMaterial) bound to setJobSplitByMaterial', () => {
    expect(cutPage).toMatch(/Разделять по материалу/);
    expect(cutPage).toMatch(/checked=\{job\.splitByMaterial\}/);
    expect(cutPage).toMatch(/setJobSplitByMaterial/);
    expect(cutPage).toMatch(/cutApi\.setSplitByMaterial/);
  });
  it('disables the toggle for read-only / busy / calculating / archived jobs', () => {
    expect(cutPage).toMatch(/!canManage \|\| busy \|\| job\.status === 'calculating' \|\| isArchivedJob/);
  });
  it('shows the cross-material override warning ONLY when split-by-material is OFF', () => {
    // Under default split=true the override only fills no-sheet details, so the
    // "all on one sheet" warning must be gated on !job.splitByMaterial.
    expect(cutPage).toMatch(/\{mixed && !job\.splitByMaterial && \(/);
  });
});

describe('Enlarged sheet preview is ~2× larger', () => {
  it('open sheet spans the full previews row instead of the thumbnail column', () => {
    expect(cutPage).toMatch(/sheetImages\[key\]\s*\?\s*\{ flex: '1 1 100%'/);
  });
  it('full-view image cap is doubled (1800)', () => {
    expect(sheetPreview).toMatch(/maxWidth: 1800/);
  });
});

describe('Manual sheet editor sheet management', () => {
  it('wires add/remove sheet controls through CutPage and SheetEditor', () => {
    expect(cutPage).toMatch(/add-manual-sheet-btn/);
    expect(cutPage).toMatch(/addEditorSheet/);
    expect(cutPage).toMatch(/onRemoveSheet=\{removeEditorSheet\}/);
    expect(sheetEditor).toMatch(/Удалить пустой лист/);
    expect(sheetEditor).toMatch(/DeleteOutlined/);
  });
});

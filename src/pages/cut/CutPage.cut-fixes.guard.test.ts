import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-text guards for the 2026-07-14 cut fixes in CutPage.tsx:
 * 1) manual-editor move guard mirrors the sheet-override semantics,
 * 2) «Разделять по материалу» stays editable for vacuum_table profiles,
 * 3) sticky back-to-top button inside each group card.
 * Runs under vitest env=node (no jsdom) — assert on the source text.
 */
const src = readFileSync(fileURLToPath(new URL('./CutPage.tsx', import.meta.url)), 'utf8');

describe('CutPage cut-fixes guard', () => {
  it('move guard uses the job sheet override as the effective piece material', () => {
    // Without the override fallback every cross-sheet move on override jobs is
    // vetoed with «другой материал листа» (group carries the override id while
    // details keep their own sheet type). Behavior is unit-tested in
    // cutPieceMeta.test.ts; here we pin that CutPage actually delegates.
    expect(src).toMatch(/buildPieceMetaByItemId\(job\?\.items \?\? \[\], job\?\.sheetMaterialTypeId \?\? null\)/);
    expect(src).toMatch(/\[job\?\.items,\s*job\?\.sheetMaterialTypeId\]/);
    const helper = readFileSync(fileURLToPath(new URL('./cutPieceMeta.ts', import.meta.url)), 'utf8');
    expect(helper).toMatch(/jobSheetMaterialTypeId\s*\?\?\s*it\.detail\?\.sheetMaterialTypeId/);
  });

  it('split-by-material checkbox stays enabled for vacuum_table profiles with a sheet override', () => {
    expect(src).toMatch(/isVacuumProfileId/);
    expect(src).toMatch(/layout_mode.*===\s*'vacuum_table'/);
    expect(src).toMatch(/job\.sheetMaterialTypeId != null && !isVacuumProfileId\(job\.paramProfileId\)/);
  });

  it('renders a fixed back-to-top button once the page has been scrolled', () => {
    expect(src).toMatch(/backToTopFixedStyle/);
    expect(src).toMatch(/position: 'fixed'/);
    expect(src).toMatch(/window\.scrollY > 150/);
    expect(src).toMatch(/data-testid="back-to-top-btn"/);
    expect(src).toMatch(/scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/);
    expect(src).toMatch(/Наверх/);
    expect(src).toMatch(/scrollMarginTop: stickyHeaderTop/);
    // target priority: the group being edited wins over viewport lookup
    expect(src).toMatch(/let targetId: number \| null = editingGroupId/);
  });
});

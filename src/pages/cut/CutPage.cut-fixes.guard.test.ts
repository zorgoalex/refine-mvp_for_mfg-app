import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-text guards for the 2026-07-14 cut fixes in CutPage.tsx:
 * 1) manual-editor move guard mirrors the sheet-override semantics,
 * 2) vacuum_table locks incompatible grouping flags,
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

  it('vacuum_table profile disables both grouping checkboxes', () => {
    expect(src).toMatch(/isVacuumTableProfile/);
    expect(src.match(/isVacuumTableProfile\(job\.paramProfileId, profiles\)/g)).toHaveLength(3);
  });

  it('defaults vacuum-table sheet previews to landscape', () => {
    expect(src).toMatch(
      /loadSheetOrientationPortrait\(\s*uid,\s*job\.cutJobId,\s*!isVacuumTableProfile\(job\.paramProfileId, profiles\)/,
    );
  });

  it('declares profiles before the orientation effect reads it', () => {
    const profileStateIndex = src.indexOf('const [profiles, setProfiles] = useState<CutParamProfile[]>([])');
    const orientationEffectIndex = src.indexOf('loadSheetOrientationPortrait(');

    expect(profileStateIndex).toBeGreaterThan(-1);
    expect(orientationEffectIndex).toBeGreaterThan(-1);
    expect(profileStateIndex).toBeLessThan(orientationEffectIndex);
  });

  it('renders a fixed back-to-top button once the page has been scrolled', () => {
    expect(src).toMatch(/backToTopFixedStyle/);
    expect(src).toMatch(/position: 'fixed'/);
    expect(src).toMatch(/window\.scrollY > 0/); // ANY vertical scroll shows the button
    // group-detection heuristic follows the MEASURED sticky offset, not a literal
    expect(src).toMatch(/stickyHeaderTop \+ 16/);
    expect(src).toMatch(/top <= viewportTopEdge/);
    expect(src).toMatch(/data-testid="back-to-top-btn"/);
    expect(src).toMatch(/scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/);
    expect(src).toMatch(/Наверх/);
    expect(src).toMatch(/scrollMarginTop: stickyHeaderTop/);
    // target priority: the group being edited wins over viewport lookup
    expect(src).toMatch(/let targetId: number \| null = editingGroupId/);
  });
});

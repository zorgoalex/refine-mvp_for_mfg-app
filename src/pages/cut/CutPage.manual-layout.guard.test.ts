import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-text guards for Task 11 manual-layout wiring in CutPage.tsx.
 * All assertions run under vitest env=node (no jsdom) — read the source file
 * directly and assert the required patterns exist.
 */
const src = readFileSync(fileURLToPath(new URL('./CutPage.tsx', import.meta.url)), 'utf8');

describe('CutPage manual-layout guard', () => {
  it('adds the edit button, alternative toggle, and save button', () => {
    expect(src).toMatch(/Редактировать раскрой/);
    expect(src).toMatch(/Показать альтернативный/);
    expect(src).toMatch(/Сохранить изменения/);
  });

  it('disables save while violations exist', () => {
    expect(src).toMatch(/disabled=\{.*violation/i);
  });

  it('renders stale badge for an outdated manual layout', () => {
    expect(src).toMatch(/устарел/);
  });

  it('«устарел» badge requires recalc OR an ACTIVE stale manual — an inactive stale manual must not flag the group (so «Рассчитать» clears it)', () => {
    expect(src).toMatch(/\(job\.requiresRecalc \?\? false\) \|\| \(isStale && persistedActive\)/);
  });

  it('busts the sheet-blob cache via resetSheetViews on every render-changing op; renderVersion stays in the FETCH (server bust), not the client key', () => {
    // renderVersion is still passed to the fetch for server render-cache busting.
    expect(src).toMatch(/renderVersion/);
    // The client blob cache key is group:sheet:variant:orientation:origin (NO
    // renderVersion) so a version bump that does not recompute the layout
    // (profile/material change) re-uses the cached preview instead of
    // re-fetching/flickering; orientation AND origin are in the key so a job-switch
    // orientation/origin rehydrate re-fetches (no stale-pref dedupe).
    expect(src).toMatch(/`\$\{group\.cutGroupId\}:\$\{sheetIndex\}:\$\{variant\}:\$\{sheetPortrait \? 'P' : 'L'\}:\$\{sheetOriginTopLeft \? 'tl' : 'raw'\}`/);
    // resetSheetViews clears blobs + the dedup set + bumps the epoch.
    expect(src).toContain('thumbReqRef.current = new Set()');
    expect(src).toMatch(/viewEpochRef\.current \+= 1/);
  });

  it('derives effectiveManual (is_active && !is_stale) for display and disables editor on requiresRecalc', () => {
    expect(src).toMatch(/effectiveManual/);
    expect(src).toMatch(/requiresRecalc/);
  });

  it('warns about invalid legacy auto geometry and blocks manual editing until recalculation', () => {
    expect(src).toContain('legacy-auto-layout-warning');
    expect(src).toContain('Раскрой создан старой версией оптимизатора');
    expect(src).toMatch(/legacyAutoLayoutInvalid.*autoLayoutValidation\?\.valid === false/);
    expect(src).toMatch(/editDisabled.*legacyAutoLayoutInvalid/);
  });

  it('disables the alternative-view checkbox with tooltip when manualLayout is stale (prevents variant=manual 409)', () => {
    // The stale-disable tooltip must be present.
    expect(src).toContain('Ручной раскрой устарел — пересчитайте');
    // The checkbox disabled prop must include isStale.
    expect(src).toMatch(/disabled=\{[^}]*isStale/);
    // displayVariant must be guarded so stale never passes variant=manual to the backend.
    expect(src).toMatch(/displayVariant.*isStale|showAlt && !isStale/s);
  });

  it('preview block uses selectVariantSheets to honour the active display variant', () => {
    expect(src).toMatch(/selectVariantSheets/);
    expect(src).toMatch(/previewSheets\.map/);
  });
});

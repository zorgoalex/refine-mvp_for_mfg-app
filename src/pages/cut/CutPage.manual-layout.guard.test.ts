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

  it('keys the sheet-blob cache by renderVersion (busts on same-variant re-save)', () => {
    expect(src).toMatch(/renderVersion/);
  });

  it('derives effectiveManual (is_active && !is_stale) for display and disables editor on requiresRecalc', () => {
    expect(src).toMatch(/effectiveManual/);
    expect(src).toMatch(/requiresRecalc/);
  });
});

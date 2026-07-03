import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('global mobile.css wiring', () => {
  it('App.tsx imports styles/mobile.css globally', () => {
    expect(read('App.tsx')).toContain("./styles/mobile.css");
  });
  it('mobile.css hides brand subline on phone and enforces coarse-pointer touch targets', () => {
    const css = read('styles/mobile.css');
    expect(css).toContain('max-width: 767px');
    expect(css).toContain('.app-header__brand-sub');
    expect(css).toContain('pointer: coarse');
    expect(css).toMatch(/min-height:\s*44px/);
  });
  it('calendar-mobile.css no longer carries app-header rules (moved to global)', () => {
    expect(read('pages/calendar/styles/calendar-mobile.css')).not.toContain('.app-header__brand');
  });
  it('AppHeader marks theme toggle and username for phone hiding', () => {
    const src = read('components/AppHeader.tsx');
    expect(src).toContain('app-header__theme-toggle');
    expect(src).toContain('app-header__username');
  });
  it('mobile.css keeps workspace tabs on a single scrollable row on phone', () => {
    const css = read('styles/mobile.css');
    expect(css).toContain('.workspace-tabs');
    expect(css).toMatch(/\.workspace-tabs[\s\S]*overflow-x:\s*auto/);
    expect(css).toMatch(/max-width:\s*40vw/);
  });
  it('AppFooter marks date/session as hideable meta', () => {
    expect(read('components/AppFooter.tsx')).toContain('app-footer__meta');
  });
});

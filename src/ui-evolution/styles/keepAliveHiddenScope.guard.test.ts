import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Open workspace tabs stay mounted inside the screen frame, hidden ([hidden]). A frame-wide :has(page)
// rule therefore applies while that page is only open in another tab: the order card's «hide the page
// heading» rule hid the filters and search of the orders list after visiting an order (04.11).
describe('Shell styles: :has(page) on the shared screen frame / shell counts only the visible page', () => {
  it('scopes frame/content :has() rules to pages that are not inside a hidden tab', () => {
    const files = [
      ...readdirSync('src/ui-evolution/styles').filter((name) => name.endsWith('.css')).map((name) => `src/ui-evolution/styles/${name}`),
      'src/ui-operational/operational.css',
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const css = readFileSync(file, 'utf8');
      for (const line of css.split('\n')) {
        for (const anchor of ['.evolution-screen-frame:has(', '.evolution-shell__content:has(', '.evolution-shell--wb-phone:has(', '.evolution-shell:has(']) {
          const at = line.indexOf(anchor);
          if (at < 0) continue;
          const inner = line.slice(at + anchor.length);
          // rail/structure checks with a direct child (`> .x`) are not about pages in tabs
          if (inner.trimStart().startsWith('>')) continue;
          // shell-level parts (the phone tab bar) are not pages in tabs
          if (inner.trimStart().startsWith('.wb-mtabbar')) continue;
          if (!inner.includes(':not([hidden] *)')) offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

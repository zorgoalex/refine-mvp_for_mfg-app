import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Open workspace tabs stay mounted inside the screen frame, hidden ([hidden]). A frame-wide :has(page)
// rule therefore applies while that page is only open in another tab: the order card's «hide the page
// heading» rule hid the filters and search of the orders list after visiting an order (04.11).
describe('NewLine styles: :has(page) on the shared screen frame counts only the visible page', () => {
  it('scopes frame/content :has() rules to pages that are not inside a hidden tab', () => {
    const dir = 'src/ui-evolution/styles';
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.startsWith('workbench') && name.endsWith('.css'))) {
      const css = readFileSync(`${dir}/${file}`, 'utf8');
      for (const line of css.split('\n')) {
        for (const anchor of ['.evolution-screen-frame:has(', '.evolution-shell__content:has(']) {
          const at = line.indexOf(anchor);
          if (at < 0) continue;
          const inner = line.slice(at + anchor.length);
          // rail/structure checks with a direct child (`> .x`) are not about pages in tabs
          if (inner.trimStart().startsWith('>')) continue;
          if (!inner.includes(':not([hidden] *)')) offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

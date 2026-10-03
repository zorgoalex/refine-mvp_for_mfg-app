import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

describe('evolution CSS isolation', () => {
  const source = readFileSync('src/ui-evolution/styles/evolution.css', 'utf8');
  const root = postcss.parse(source);
  const allowedSelectorPrefixes = [
    ':root[data-ui-variant="evolution"]',
    ':root[data-ui-variant="line"]',
    ':root[data-ui-variant="air"]',
    ':root[data-ui-variant="neutral"]',
    ':root[data-ui-variant="workbench"]',
    ':root:where([data-ui-variant="evolution"], [data-ui-variant="line"], [data-ui-variant="air"], [data-ui-variant="neutral"], [data-ui-variant="workbench"])',
    ':root:where([data-ui-variant="line"], [data-ui-variant="air"])',
  ];

  it('scopes every style rule to the runtime document marker', () => {
    const unscoped: string[] = [];
    root.walkRules((rule) => {
      rule.selectors.forEach((selector) => {
        if (!allowedSelectorPrefixes.some((prefix) => selector.trim().startsWith(prefix))) {
          unscoped.push(selector);
        }
      });
    });

    expect(unscoped).toEqual([]);
  });

  it('avoids broad transition declarations', () => {
    expect(source).not.toMatch(/transition\s*:\s*all\b/);
  });

  it('keeps all modern palette blocks explicit', () => {
    expect(source).toContain(':root[data-ui-variant="evolution"]');
    expect(source).toContain(':root[data-ui-variant="line"]');
    expect(source).toContain(':root[data-ui-variant="air"]');
    expect(source).toContain(':root[data-ui-variant="neutral"]');
    expect(source).toContain(':root:where([data-ui-variant="evolution"], [data-ui-variant="line"], [data-ui-variant="air"], [data-ui-variant="neutral"], [data-ui-variant="workbench"])');
  });

  it.each([
    'src/ui-evolution/styles/workbench.css',
    'src/ui-evolution/styles/workbench-orders.css',
    'src/ui-evolution/styles/workbench-calendar.css',
    'src/ui-evolution/styles/workbench-cut.css',
    'src/ui-evolution/styles/workbench-board.css',
  ])('keeps the workbench stylesheet %s scoped to its own variant marker', (file) => {
    const workbench = postcss.parse(readFileSync(file, 'utf8'));
    const unscoped: string[] = [];
    workbench.walkRules((rule) => {
      rule.selectors.forEach((selector) => {
        if (!selector.trim().startsWith(':root[data-ui-variant="workbench"]')) unscoped.push(selector);
      });
    });
    expect(unscoped).toEqual([]);
  });

  it('declares the workbench palette for both themes', () => {
    expect(source).toContain(':root[data-ui-variant="workbench"] {');
    expect(source).toContain(':root[data-ui-variant="workbench"][data-theme="dark"] {');
  });
});

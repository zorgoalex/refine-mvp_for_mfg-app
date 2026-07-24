import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

describe('evolution CSS isolation', () => {
  const source = readFileSync('src/ui-evolution/styles/evolution.css', 'utf8');
  const root = postcss.parse(source);

  it('scopes every style rule to the runtime document marker', () => {
    const unscoped: string[] = [];
    root.walkRules((rule) => {
      rule.selectors.forEach((selector) => {
        if (!selector.trim().startsWith(':root[data-ui-variant="evolution"]')) {
          unscoped.push(selector);
        }
      });
    });

    expect(unscoped).toEqual([]);
  });

  it('avoids broad transition declarations', () => {
    expect(source).not.toMatch(/transition\s*:\s*all\b/);
  });
});

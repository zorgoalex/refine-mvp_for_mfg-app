import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Node-only Vitest (no jsdom) — guard the UI invariants via source text.
const show = readFileSync(resolve(__dirname, 'show.tsx'), 'utf8');
const list = readFileSync(resolve(__dirname, 'list.tsx'), 'utf8');

describe('doweling show card', () => {
  it('uses a two-column layout (two side-by-side lg=12 columns of Descriptions)', () => {
    expect(show).toContain('Descriptions');
    const lgHalves = show.match(/<Col xs=\{24\} lg=\{12\}>/g) ?? [];
    expect(lgHalves.length).toBe(2);
    // compact, scroll-avoiding: bordered small Descriptions, no per-field <Title>/<Divider> stack
    expect(show).toContain('size: "small"');
    expect(show).not.toContain('<Divider');
  });
});

describe('doweling list', () => {
  it('opens the SHOW card on row double-click (not edit)', () => {
    expect(list).toContain('const { show } = useNavigation()');
    expect(list).toMatch(/onDoubleClick:[\s\S]*?show\("doweling_orders"/);
    expect(list).not.toMatch(/onDoubleClick:[\s\S]*?edit\("doweling_orders"/);
  });
});

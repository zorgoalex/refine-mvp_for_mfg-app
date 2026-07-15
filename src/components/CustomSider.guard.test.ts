import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./CustomSider.tsx', import.meta.url), 'utf8');

describe('CustomSider expanded labels', () => {
  it('uses half-size text and wraps complete labels by words', () => {
    expect(source).toContain('font-size: 0.64em');
    expect(source).toContain('.sidebar-collapse .ant-menu-title-content { overflow: visible; white-space: normal; }');
    expect(source).toContain('text-overflow: clip');
    expect(source).toContain('white-space: normal');
    expect(source).toContain('word-break: normal');
    expect(source).toContain('text-wrap: pretty');
  });

  it('gates the trash menu item with canViewNavigation for orders-trash', () => {
    expect(source).toContain("canViewNavigation('orders-trash')");
  });
});

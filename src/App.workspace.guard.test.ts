import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(resolve(__dirname, 'App.tsx'), 'utf8');

describe('App workspace wiring', () => {
  it('drops the Refine Layout= prop (single outlet host via variant shell registry)', () => {
    expect(src).not.toContain('Layout={CustomLayout}');
    expect(src).toContain('<VariantWorkspaceLayout');
  });
  it('does not rely on Refine warnWhenUnsavedChanges', () => {
    expect(src).toContain('warnWhenUnsavedChanges: false');
  });
});

import { describe, expect, it } from 'vitest';
import vitestConfig from '../vitest.config';

const testConfig = (vitestConfig as {
  test?: { include?: string[]; exclude?: string[] };
}).test;

describe('root Vitest discovery', () => {
  it('excludes nested Claude worktrees without excluding current repository tests', () => {
    expect(testConfig?.exclude).toContain('.claude/worktrees/**');
    expect(testConfig?.include).toContain('**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}');
    expect(testConfig?.exclude).not.toContain('scripts/**');
    expect(testConfig?.exclude).not.toContain('src/**');
  });
});

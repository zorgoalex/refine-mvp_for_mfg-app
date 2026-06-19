import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./useFormWithHighlight.ts', import.meta.url), 'utf8');

describe('useFormWithHighlight tab title enrichment', () => {
  it('updates edit workspace tabs from loaded record data', () => {
    expect(source).toMatch(/useRecordTabTitle/);
    expect(source).toMatch(/actionLabel:\s*["']Редактирование["']/);
    expect(source).toMatch(/record:\s*formReturn\.queryResult\?\.data\?\.data/);
  });
});

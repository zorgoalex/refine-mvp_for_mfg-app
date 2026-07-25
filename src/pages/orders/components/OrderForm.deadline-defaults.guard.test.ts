import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./OrderForm.tsx', import.meta.url), 'utf8');

describe('OrderForm deadline defaults', () => {
  it('does not restore the historical hard-coded +10 day fallback', () => {
    expect(source).not.toMatch(/add\(10,\s*['"]day['"]\)/);
    expect(source).toContain('computePlannedCompletionDate');
    expect(source).toMatch(/deadlinesApi\s*\.\s*getDefaultSchedule/);
  });
});

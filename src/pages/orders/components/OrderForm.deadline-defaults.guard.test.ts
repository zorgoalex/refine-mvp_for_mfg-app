import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./OrderForm.tsx', import.meta.url), 'utf8');

describe('OrderForm deadline defaults', () => {
  it('does not restore the historical hard-coded +10 day fallback', () => {
    expect(source).not.toMatch(/add\(10,\s*['"]day['"]\)/);
    expect(source).toContain('computePlannedCompletionDate');
    expect(source).toContain('applicableProductionStatusIds');
    expect(source).toContain('workshop.production_status_id');
    expect(source).toMatch(/deadlinesApi\s*\.\s*getDefaultSchedule/);
  });

  it('preserves the last-good schedule while the workspace is inactive', () => {
    const effectStart = source.indexOf('// Initialize form with default values for create mode');
    const fetchStart = source.indexOf('deadlinesApi\n      .getDefaultSchedule()', effectStart);
    const effectSource = source.slice(effectStart, fetchStart);

    expect(effectSource).toContain("if (!ordinaryReadActive) {");
    expect(effectSource.indexOf("setDeadlineDefaultScheduleState({"))
      .toBeLessThan(effectSource.indexOf("if (!ordinaryReadActive) {"));
    expect(effectSource.slice(effectSource.indexOf("if (!ordinaryReadActive) {")))
      .not.toContain("setDeadlineDefaultScheduleState({");
  });
});

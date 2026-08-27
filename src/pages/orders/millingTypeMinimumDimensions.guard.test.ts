import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tableSource = readFileSync(
  new URL('./components/tables/OrderDetailTable.tsx', import.meta.url),
  'utf8',
);

describe('order detail milling type minimum dimensions UI', () => {
  it('shows a non-blocking warning and keeps the full milling catalog available', () => {
    expect(tableSource).toContain('millingTypeDimensionWarning');
    expect(tableSource).toContain("validateStatus={selectedMillingTypeDimensionWarning ? 'warning' : undefined}");
    expect(tableSource).toContain('help={selectedMillingTypeDimensionWarning}');
    expect(tableSource).toMatch(/<Select\s+\{\.\.\.resolvedMillingTypeSelectProps\}/);
    expect(tableSource).not.toContain('availableMillingTypeOptions');
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Source-text guards: the order show page exposes the detail-level cut picker,
// gated by useBackendCut + cut.manage, and passes chosen detailIds to AddToCutModal.
const source = readFileSync(fileURLToPath(new URL('./show.tsx', import.meta.url)), 'utf8');

describe('OrderShow cut detail-picker guards', () => {
  it('gates the cut picker behind useBackendCut and cut.manage', () => {
    expect(source).toContain('featureFlags.useBackendCut');
    expect(source).toContain("can('cut.manage')");
  });

  it('wires the detail picker into AddToCutModal with detailIds', () => {
    expect(source).toContain('AddToCutModal');
    expect(source).toContain('Выделить детали для раскроя');
    expect(source).toContain('detailIds=');
  });
});

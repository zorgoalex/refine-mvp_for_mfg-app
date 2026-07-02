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
    expect(source).toContain('orderNames={[record.order_name]}');
  });

  it('renders a «Раскрой» sub-block listing all cut jobs for the order', () => {
    // cut.view-gated placements fetch for this order's details (multi-job).
    expect(source).toContain('.listPlacements({ orderIds: [record.order_id] })');
    expect(source).toContain('cutOrderJobs');
    // Each job is a deep-link into /cut?job=<id>.
    expect(source).toContain('cutJobDeepLink(j.cutJobId)');
  });
});

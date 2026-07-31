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
    expect(source).toContain('cutApi.listPlacements');
    expect(source).toContain('orderIds: [orderId]');
    expect(source).toContain('cutOrderJobs');
    // Each job is a deep-link into /cut?job=<id>.
    expect(source).toContain('cutJobDeepLink(j.cutJobId)');
    expect(source).toContain('Профиль: {cutJobProfileLabel(j)}');
  });

  it('renders embedded cut screen as a top order info tab', () => {
    expect(source).toContain("key: 'cut', label: 'Раскрой'");
    expect(source).toContain('import { CutPage }');
    expect(source).toContain('<CutPage embeddedOrderId={record.order_id} />');
    expect(source).toContain("activeInfoPanel === 'cut'");
  });

  it('renders two-column order materials with linked bath cut jobs in the read-only order card', () => {
    expect(source).toContain('computeOrderBathFilmUsage');
    expect(source).toContain('Материалы заказа');
    expect(source).toContain('buildOrderFilmMaterialRows');
    expect(source).toContain('buildOrderSheetMaterialRows');
    expect(source).toContain('<CutJobLinks cutJobIds={value} cutJobNameById={cutJobNameById} />');
    expect(source).toContain('formatNumber(value, 1)');
    expect(source).toContain('bathCutJobs');
  });
});

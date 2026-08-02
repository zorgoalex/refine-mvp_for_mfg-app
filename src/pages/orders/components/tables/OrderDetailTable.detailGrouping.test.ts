// src/pages/orders/components/tables/OrderDetailTable.detailGrouping.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const table = readFileSync(join(__dirname, 'OrderDetailTable.tsx'), 'utf8');
const tab = readFileSync(join(__dirname, '../tabs/OrderDetailsTab.tsx'), 'utf8');

describe('edit-form detail grouping', () => {
  it('tab owns grouping state and renders controls', () => {
    expect(tab).toContain('useDetailGrouping');
    expect(tab).toContain('<DetailGroupingControls');
    expect(tab).toContain('groupField');
  });
  it('table builds grouped rows and marks the table grouped', () => {
    expect(table).toContain('buildGroupedRows');
    expect(table).toContain("'separator'");
    expect(table).toContain("'summary'");
    expect(table).toContain('details-grouped');
  });
  it('uses raw sortedDetails when separation is off (no clustering)', () => {
    expect(table).toMatch(/groupingActive\s*\?\s*[^:]*buildGroupedRows[\s\S]*?:\s*sortedDetails/);
  });
  it('disables column sorters when grouping is active', () => {
    expect(table).toMatch(/groupingActive[\s\S]{0,80}(sorter|defaultSortOrder)/);
  });
  it('makes row selection separator-aware', () => {
    expect(table).toContain('getCheckboxProps');
  });
  it('renders group summaries with the same total columns and colors as the overall summary', () => {
    expect(table).toContain('renderGroupedSummaryValue');
    expect(table).toContain("key === 'quantity'");
    expect(table).toContain("key === 'area'");
    expect(table).toContain("key === 'detail_cost'");
    expect(table).toContain("color: '#1890ff'");
    expect(table).toContain("color: '#52c41a'");
    expect(table).toContain('detail-group-summary');
  });
  it('renders summary totals without layout measuring or text scaling', () => {
    expect(table).toContain('SUMMARY_TEXT_BASE_STYLE');
    expect(table).toContain("width: 'max-content'");
    expect(table).toContain("whiteSpace: 'nowrap'");
    expect(table).toContain("fontVariantNumeric: 'tabular-nums'");
    expect(table).not.toContain('ResizeObserver');
    expect(table).not.toContain('scrollWidth');
    expect(table).not.toContain('clientWidth');
    expect(table).not.toContain('scaleX');
  });
  it('keeps total columns wide enough for full summary values', () => {
    expect(table).toContain('ORDER_DETAIL_TOTAL_COLUMN_WIDTHS');
    expect(table).toContain('detailNumber: 44');
    expect(table).toContain('quantity: 96');
    expect(table).toContain('area: 128');
    expect(table).toContain('detailCost: 150');
    expect(table).toContain('width: ORDER_DETAIL_TOTAL_COLUMN_WIDTHS.detailNumber');
    expect(table).toContain('width: ORDER_DETAIL_TOTAL_COLUMN_WIDTHS.quantity');
    expect(table).toContain('width: ORDER_DETAIL_TOTAL_COLUMN_WIDTHS.area');
    expect(table).toContain('width: ORDER_DETAIL_TOTAL_COLUMN_WIDTHS.detailCost');
  });
  it('renders a persisted-only group checkbox + group label on separators when cutSelectable', () => {
    expect(table).toContain('cutSelectable');
    expect(table).toContain('groupCheckboxState');
    expect(table).toContain('toggleGroupSelection');
    expect(table).toMatch(/detail_id\s*!=\s*null/); // groupKeyOf excludes temp-only rows
    expect(table).toContain('groupLabelOf');
    expect(table).toContain('row as any).label');
  });
  it('edit tab wires add-to-cut with persisted-id mapping + group-selectable table', () => {
    expect(tab).toContain('AddToCutModal');
    expect(tab).toContain('Добавить выбранные в раскрой');
    expect(tab).toContain('cutSelectable');
    expect(tab).toContain('selectedDetailIds');
    expect(tab).toContain('orderNames={[header.order_name]}');
  });
  it('wires persisted detail transfer into row context menu', () => {
    expect(table).toContain("key: 'action:transfer'");
    expect(table).toContain('Перенести детали');
    expect(table).toContain('onTransferRows(contextTransferRowKeys)');
    expect(tab).toContain('getTransferRowsDisabledReason={getTransferRowsDisabledReason}');
    expect(tab).toContain('onTransferRows={handleTransferRows}');
  });
  it('edit detail table exposes a cut.view-gated Раскрой column refreshed by cut ready events', () => {
    expect(tab).toContain("const cutColumnEnabled = featureFlags.useBackendCut && can('cut.view')");
    expect(tab).toContain('useCutDetailLastReady');
    expect(tab).toContain('cutJobByDetailId={cutColumnEnabled ? cutJobMaps.cutJobByDetailId : undefined}');
    expect(tab).toContain('bathCutJobByDetailId={cutColumnEnabled ? cutJobMaps.bathCutJobByDetailId : undefined}');
    expect(table).toContain("key: 'cut_job'");
    expect(table).toContain("key: 'bath_cut_job'");
    expect(table).toContain('cutJobDeepLink(ref)');
    expect(table).toContain('<CutJobVersionLines job={ref} />');
  });
});

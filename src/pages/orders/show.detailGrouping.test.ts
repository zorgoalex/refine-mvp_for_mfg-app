// src/pages/orders/show.detailGrouping.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, 'show.tsx'), 'utf8');

describe('show.tsx detail grouping integration', () => {
  it('imports the grouping pieces', () => {
    expect(src).toContain('useDetailGrouping');
    expect(src).toContain('buildGroupedRows');
    expect(src).toContain('DetailGroupingControls');
  });
  it('renders the controls above the details table', () => {
    expect(src).toContain('<DetailGroupingControls');
  });
  it('marks the table grouped and guards separator rows', () => {
    expect(src).toContain('details-grouped');
    expect(src).toContain("'separator'");
    expect(src).toContain("'summary'");
  });
  it('uses raw details when separation is off (no clustering)', () => {
    // dataSource is grouped ONLY when groupingActive; otherwise plain details
    expect(src).toMatch(/groupingActive\s*\?\s*[^:]*buildGroupedRows[\s\S]*?:\s*details/);
  });
  it('keeps grouping visible during cut-select (no !cutSelectMode suppression)', () => {
    expect(src).not.toMatch(/groupingActive[^\n]*!cutSelectMode/);
  });
  it('renders a group checkbox on separators and filters non-numeric keys', () => {
    expect(src).toContain('groupCheckboxState');
    expect(src).toContain('toggleGroupSelection');
    expect(src).toContain('filterNumericKeys');
    expect(src).toContain('renderCell');
  });
  it('passes includeLeadingSeparator while cut-selecting', () => {
    expect(src).toContain('includeLeadingSeparator');
  });
  it('renders the group label on separator rows + resolves it via groupLabelOf', () => {
    expect(src).toContain('groupLabelOf');
    expect(src).toContain('groupValueOf');
    expect(src).toContain('row.label');
  });
  it('renders per-group totals in the same columns and colors as the overall summary', () => {
    expect(src).toContain('renderGroupedSummaryValue');
    expect(src).toContain("key === 'quantity'");
    expect(src).toContain("key === 'area'");
    expect(src).toContain("key === 'detail_cost'");
    expect(src).toContain("color: '#1890ff'");
    expect(src).toContain("color: '#52c41a'");
    expect(src).toContain('detail-group-summary');
  });
  it('exports active detail grouping as blank rows between groups without summary rows', () => {
    expect(src).toContain('const buildOrderExportDetailRows = (): OrderExcelDetailRow[] =>');
    expect(src).toContain('return groupingActive && grouping.state.field');
    expect(src).toContain('buildGroupedRows(details, grouping.state.field, { groupValueOf, groupLabelOf })');
    expect(src).toContain("if (row.kind === 'separator') return [{ kind: 'blank' as const }]");
    expect(src).toContain("if (row.kind === 'detail') return [mapDetailToExcelRow(row.detail)]");
    expect(src).toContain('return [];');
    expect(src).toContain('const excelDetailRows = buildOrderExportDetailRows()');
    expect(src).toContain('details: excelDetailRows');
  });
});

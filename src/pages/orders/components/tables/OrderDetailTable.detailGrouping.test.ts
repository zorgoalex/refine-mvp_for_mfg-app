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
});

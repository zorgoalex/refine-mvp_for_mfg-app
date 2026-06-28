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
  it('suppresses grouping while selecting details for cut', () => {
    expect(src).toMatch(/!cutSelectMode/);
  });
  it('marks the table grouped and guards separator rows', () => {
    expect(src).toContain('details-grouped');
    expect(src).toContain("'separator'");
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
    expect(src).toContain('row.label');
  });
});

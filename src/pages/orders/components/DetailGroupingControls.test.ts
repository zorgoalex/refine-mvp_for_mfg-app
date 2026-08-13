// src/pages/orders/components/DetailGroupingControls.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupingButtonLabel } from './DetailGroupingControls';

describe('groupingButtonLabel', () => {
  it('shows placeholder when no field', () => {
    expect(groupingButtonLabel(null)).toBe('Группировать по…');
  });
  it('shows current field label', () => {
    expect(groupingButtonLabel('material')).toBe('Группировка: по материалам');
    expect(groupingButtonLabel('production_status')).toBe('Группировка: по статусу');
  });
});

describe('DetailGroupingControls source guards', () => {
  const src = readFileSync(join(__dirname, 'DetailGroupingControls.tsx'), 'utf8');
  it('renders the conditional separation checkbox label', () => {
    expect(src).toContain('Разделение на группы');
  });
  it('offers the no-grouping menu item', () => {
    expect(src).toContain('Без группировки');
  });
  it('only renders the checkbox when a field is selected', () => {
    expect(src).toMatch(/state\.field\s*(!==|\!=)\s*null|state\.field\s*&&/);
  });
});

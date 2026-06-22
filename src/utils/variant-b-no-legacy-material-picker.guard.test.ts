import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { filterCuttableOptions } from '../hooks/useSheetMaterialOptions';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const read = (p: string) => readFileSync(`${ROOT}/${p}`, 'utf8');

describe('Variant B: no legacy material picker', () => {
  it('order detail table no longer renders a material_id Select', () => {
    const src = read('src/pages/orders/components/tables/OrderDetailTable.tsx');
    expect(src).not.toMatch(/resource:\s*['"]materials['"]/);
  });

  it('OrderDetailModal has no dead resource:materials query', () => {
    const src = read('src/pages/orders/components/modals/OrderDetailModal.tsx');
    expect(src).not.toMatch(/resource:\s*['"]materials['"]/);
  });

  it('BulkEditModal uses filterCuttableOptions for the sheet picker', () => {
    const src = read('src/pages/orders/components/modals/BulkEditModal.tsx');
    expect(src).toMatch(/filterCuttableOptions/);
  });

  it('no order create default seeds a legacy material_id', () => {
    for (const p of [
      'src/pages/orders/components/tabs/OrderDetailsTab.tsx',
      'src/pages/orders/components/modals/OrderDetailModal.tsx',
      'src/pages/orders/components/tables/OrderDetailTable.tsx',
    ]) {
      expect(read(p)).not.toMatch(/material_id:\s*\d/);
    }
  });

  it('materials tab no longer aggregates by material_id', () => {
    const src = read('src/pages/orders/components/sections/OrderMaterialsTab.tsx');
    expect(src).toMatch(/sheet_material_type_id/);
  });

  it('filterCuttableOptions excludes non-cuttable types', () => {
    const options = [
      { value: 1, label: 'МДФ 16', widthMm: 2800, heightMm: 2070, isActive: true, isCuttable: true },
      { value: 2, label: 'Краска', widthMm: null, heightMm: null, isActive: true, isCuttable: false },
      { value: 3, label: 'ЛДСП', widthMm: 2800, heightMm: 2070, isActive: true, isCuttable: true },
    ];
    const cuttable = filterCuttableOptions(options);
    expect(cuttable.map((o) => o.value)).toEqual([1, 3]);
    expect(cuttable.some((o) => o.value === 2)).toBe(false);
  });

  it('DETAIL picker source uses filterCuttableOptions; HEADER picker keeps full list', () => {
    const detailTableSrc = read('src/pages/orders/components/tables/OrderDetailTable.tsx');
    const detailModalSrc = read('src/pages/orders/components/modals/OrderDetailModal.tsx');
    const legacySrc = read('src/pages/orders/components/sections/OrderLegacySection.tsx');

    // DETAIL pickers must use filterCuttableOptions
    expect(detailTableSrc).toMatch(/filterCuttableOptions/);
    expect(detailModalSrc).toMatch(/filterCuttableOptions/);

    // HEADER picker must NOT filter — it keeps the full catalog
    expect(legacySrc).not.toMatch(/filterCuttableOptions/);
  });

  it('groups details by sheet_material_type_id, not material_id', async () => {
    const { groupDetailsBySheet } = await import('./groupDetailsBySheet.js');
    const groups = groupDetailsBySheet([
      { detail_id: 1, material_id: null, sheet_material_type_id: 2 },
      { detail_id: 2, material_id: null, sheet_material_type_id: 2 },
      { detail_id: 3, material_id: null, sheet_material_type_id: 3 },
    ]);
    expect([...groups.keys()].sort()).toEqual([2, 3]);
    expect(groups.get(2)!.length).toBe(2);
  });
});

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const read = (p: string) => readFileSync(`${ROOT}/${p}`, 'utf8');

describe('Variant B: no legacy material picker', () => {
  it('order detail table no longer renders a material_id Select', () => {
    const src = read('src/pages/orders/components/tables/OrderDetailTable.tsx');
    expect(src).not.toMatch(/resource:\s*['"]materials['"]/);
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

import { describe, it, expect } from 'vitest';
import {
  resolveDetailMaterialName,
  resolveHeaderMaterialName,
} from './materialDisplayName';

// SP3 Task 10: display name everywhere = server-resolved COALESCE(sheet name,
// materials.material_name), keyed on sheet_material_type_id, with a legacy
// materials map kept ONLY as a defensive fallback. The helper must never need
// sheet_materials.view and must leave legacy orders byte-for-byte unchanged.
describe('resolveDetailMaterialName', () => {
  it('legacy detail: falls back to the materials map by material_id (unchanged)', () => {
    const detail = { detail_id: 1, material_id: 5 };
    const map = { 5: 'ЛДСП Дуб' };
    expect(resolveDetailMaterialName(detail, undefined, map)).toBe('ЛДСП Дуб');
  });

  it('sheet detail: prefers the server-resolved material_name over the (shadow) map entry', () => {
    // shadow material_id 99 would resolve to a disambiguated "...[лист #N]" name
    const detail = { detail_id: 2, material_id: 99, material_name: 'МДФ 16 мм' };
    const map = { 99: 'МДФ 16 мм [лист #2]' };
    expect(resolveDetailMaterialName(detail, undefined, map)).toBe('МДФ 16 мм');
  });

  it('edit-workspace store detail: uses material_name_resolved (Task 8 hydration)', () => {
    const detail = { detail_id: 3, material_id: 99, material_name_resolved: 'МДФ 18 мм' };
    expect(resolveDetailMaterialName(detail, undefined, {})).toBe('МДФ 18 мм');
  });

  it('backend-read DTO: uses detail.materialName', () => {
    const detail = { detail_id: 4, material_id: 7, materialName: 'ЛДСП Венге' };
    expect(resolveDetailMaterialName(detail, undefined, undefined)).toBe('ЛДСП Венге');
  });

  it('display surface: a resolvedByDetailId map (order_details_view) wins over the legacy map', () => {
    const detail = { detail_id: 10, material_id: 99 };
    const resolved = new Map<number, string | null>([[10, 'Sheet Material A']]);
    const map = { 99: 'wrong shadow name' };
    expect(resolveDetailMaterialName(detail, resolved, map)).toBe('Sheet Material A');
  });

  it('empty resolved name does not mask the legacy fallback', () => {
    const detail = { detail_id: 11, material_id: 5, material_name: '' };
    const map = { 5: 'ЛДСП Дуб' };
    expect(resolveDetailMaterialName(detail, undefined, map)).toBe('ЛДСП Дуб');
  });

  it('nothing resolvable: returns null', () => {
    expect(resolveDetailMaterialName({ detail_id: 12 }, undefined, {})).toBeNull();
  });
});

describe('resolveHeaderMaterialName', () => {
  it('prefers material_name_resolved (store) then material_name (orders_view)', () => {
    expect(resolveHeaderMaterialName({ material_name_resolved: 'A', material_name: 'B' })).toBe('A');
    expect(resolveHeaderMaterialName({ material_name: 'B' })).toBe('B');
  });

  it('backend header COALESCE name', () => {
    expect(resolveHeaderMaterialName({ headerMaterialName: 'C' })).toBe('C');
  });

  it('empty / missing: returns null', () => {
    expect(resolveHeaderMaterialName({ material_name: '' })).toBeNull();
    expect(resolveHeaderMaterialName({})).toBeNull();
  });
});

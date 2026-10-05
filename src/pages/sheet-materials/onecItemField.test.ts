import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { onecItemOptions } from './OnecItemField';
import { nomenclatureFromOnec } from './onecItemFill';

const item = { refKey: 'f4bfb4c0-d6bf-43d8-86b4-88b01b8cba9b', code: '00-000123', name: 'МДФ 16 мм', unitName: 'л.', categoryName: 'Сырье', nomenclatureType: 'Запас', deletionMark: false, linkedSheetMaterialTypeId: null, linkedName: null };

describe('sheet material form: 1C item picker', () => {
  it('searches by name, code, unit and category; an item of another sheet material cannot be picked, the own one can', () => {
    const taken = { ...item, refKey: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'МДФ 18 мм', linkedSheetMaterialTypeId: 9, linkedName: 'МДФ 18мм', deletionMark: true };
    const options = onecItemOptions([item, taken], 9, null);
    expect(options[0]).toMatchObject({ value: item.refKey, label: 'МДФ 16 мм · 00-000123 · л. · Сырье', disabled: false });
    // Своя позиция (редактируется материал 9) — доступна и без пометки о привязке.
    expect(options[1]).toMatchObject({ label: 'МДФ 18 мм · 00-000123 · л. · Сырье · помечена на удаление', disabled: false });
    expect(onecItemOptions([taken], 8, null)[0]).toMatchObject({ label: 'МДФ 18 мм · 00-000123 · л. · Сырье · помечена на удаление — привязана к «МДФ 18мм»', disabled: true });
    expect(onecItemOptions([taken], null, null)[0].disabled).toBe(true);
  });
  it('keeps the current key that is missing in the 1C data; matches keys case-insensitively', () => {
    expect(onecItemOptions([item], 8, '11111111-2222-3333-4444-555555555555')[0]).toEqual({ value: '11111111-2222-3333-4444-555555555555', label: '11111111-2222-3333-4444-555555555555 — нет в данных 1С', disabled: false, item: null });
    expect(onecItemOptions([item], 8, item.refKey.toUpperCase())).toHaveLength(1);
  });
  it('fills only empty nomenclature fields from the picked item', () => {
    expect(nomenclatureFromOnec({}, item)).toEqual({ nomenclatureType: 'Запас', nomenclatureCategory: 'Сырье' });
    expect(nomenclatureFromOnec({ nomenclatureType: 'Своё', nomenclatureCategory: ' ' }, item)).toEqual({ nomenclatureCategory: 'Сырье' });
    expect(nomenclatureFromOnec({}, { nomenclatureType: null, categoryName: '<Без категории>' })).toEqual({});
  });
  it('is used by both forms and falls back to manual input without the backend list or 1C data', () => {
    const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const file of ['./edit.tsx', './create.tsx']) expect(read(file)).toContain('<Form.Item name="refKey1c" label="Позиция 1С">\n              <OnecItemField');
    const field = read('./OnecItemField.tsx');
    expect(field).toContain('enabled: capabilities.onecItemPicker,');
    expect(field).toContain("if (!capabilities.onecItemPicker || !query.data?.available) {");
    expect(field).toContain("onChange?.(next ?? '');");
  });
});

import { describe, expect, it } from 'vitest';
import { buildRecordTabTitle, pickRecordTitle } from './recordTitle';

describe('pickRecordTitle', () => {
  it('uses human-readable name fields before ids', () => {
    expect(pickRecordTitle({ id: 3, name: 'ЛДСП 16 мм' })).toBe('ЛДСП 16 мм');
    expect(pickRecordTitle({ material_type_id: 2, material_type_name: 'МДФ' })).toBe('МДФ');
  });

  it('ignores blank values and falls back to a stable id label', () => {
    expect(pickRecordTitle({ name: '  ', sheet_material_type_id: 7 })).toBe('#7');
    expect(pickRecordTitle(undefined, '3')).toBe('#3');
  });
});

describe('buildRecordTabTitle', () => {
  it('builds action tab labels with record names', () => {
    expect(
      buildRecordTabTitle({
        resourceLabel: 'Листовые материалы',
        actionLabel: 'Редактирование',
        record: { sheet_material_type_id: 3, name: 'ЛДСП 16 мм' },
        fallbackId: '3',
      })
    ).toBe('Листовые материалы · Редактирование · ЛДСП 16 мм');
  });
});

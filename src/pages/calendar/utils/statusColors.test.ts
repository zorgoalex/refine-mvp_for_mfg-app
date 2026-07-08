import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getMaterialsForCard } from './statusColors';

describe('calendar material card tags', () => {
  it('renders short material tags from resolved sheet material names', () => {
    const details = [
      { material: { material_name: 'МДФ 18мм - белый' } },
      { material: { material_name: 'ЛДСП Дуб' } },
      { material: { material_name: 'МДФ 18мм - белый' } },
    ];

    expect(getMaterialsForCard(details, true)).toEqual([
      { name: '18мм', fullName: 'МДФ 18мм - белый' },
      { name: 'ЛДСП', fullName: 'ЛДСП Дуб' },
    ]);
  });

  it('keeps hiding default MDF 16mm from standard calendar cards', () => {
    const details = [
      { material: { material_name: 'МДФ 16мм' } },
      { material: { material_name: 'МДФ 8мм' } },
    ];

    expect(getMaterialsForCard(details, true)).toEqual([
      { name: '8мм', fullName: 'МДФ 8мм' },
    ]);
  });

  it('does not gate calendar resolved material names on the old sheetMaterialsReads flag', () => {
    const source = readFileSync(
      resolve(__dirname, '../hooks/useCalendarData.ts'),
      'utf8',
    );
    const resolvedMaterialFetch = source.split("resource: 'order_details_view'")[1] ?? '';

    expect(resolvedMaterialFetch).toContain("enabled: orderIds.length > 0");
    expect(resolvedMaterialFetch).not.toContain('sheetMaterialsReads');
  });
});

import { describe, expect, it } from 'vitest';
import { parseNodeRaw } from './parseNodeRaw';

const raw = {
  ТипОбъекта: 'Панель',
  Наименование: 'Стенка боковая',
  Длина: '600',
  СписокКромок2: { Кромка: [{ Наименование: 'Кромка ПВХ 1мм', Толщина: '1' }] },
  ОблицовкаПласти1: { Пласть: [{ Наименование: 'Плёнка ПВХ глянец' }] },
  Отверстие: [{ Диаметр: '5', Глубина: '12' }, { Диаметр: '8' }],
  Свойство: [{ Наименование: 'Артикул', Значение: 'АБ-12' }],
  ОсновнойМатериал: { Наименование: 'ЛДСП Белый' },
};

describe('parseNodeRaw', () => {
  it('splits raw json into sections', () => {
    const sections = parseNodeRaw(raw);

    expect(sections.edges).toEqual([
      {
        side: 2,
        fields: [
          { key: 'Наименование', value: 'Кромка ПВХ 1мм' },
          { key: 'Толщина', value: '1' },
        ],
      },
    ]);
    expect(sections.faces[0].side).toBe(1);
    expect(sections.holes).toHaveLength(2);
    expect(sections.properties).toEqual([{ key: 'Артикул', value: 'АБ-12' }]);
    expect(sections.scalars).toEqual(expect.arrayContaining([{ key: 'ТипОбъекта', value: 'Панель' }]));
    expect(sections.scalars.map((scalar) => scalar.key)).not.toContain('СписокКромок2');
  });

  it('is resilient to missing/odd shapes', () => {
    expect(parseNodeRaw({})).toMatchObject({ edges: [], faces: [], holes: [], properties: [], operations: [] });
    expect(parseNodeRaw({ СписокКромок1: 'мусор' } as never).edges).toEqual([]);
  });
});

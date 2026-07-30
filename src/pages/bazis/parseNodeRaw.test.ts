import { describe, expect, it } from 'vitest';
import { parseNodeRaw } from './parseNodeRaw';

const raw = {
  ТипОбъекта: 'Панель',
  Наименование: 'Стенка боковая',
  Длина: '600',
  СписокКромок2: { Кромка: [{ Наименование: 'Кромка ПВХ 1мм', Толщина: '1' }] },
  ОблицовкаПласти1: { Пласть: [{ Наименование: 'Плёнка ПВХ глянец' }] },
  Отверстия: { Отверстие: [
    { ПозицияX: '350', ПозицияY: '0', ПозицияZ: '8', Диаметр: '5', Глубина: '12', Тип: 'Глухое', НаправлениеX: '0', НаправлениеY: '1', НаправлениеZ: '0' },
    { Диаметр: '8' },
  ] },
  СписокПазов: { Паз: [{ Название: 'Паз для ЗС', Ширина: '4', Глубина: '8' }] },
  СписокОпераций: { СдельнаяОперация: [{ Наименование: 'Раскрой', Код: 'cut16', Стоимость: '51.52' }] },
  ПользовательскиеСвойства: {
    Свойство: [
      { Имя: 'Фрезеровка', Значение: 'Модерн' },
      { Имя: 'Пленка', Значение: 'Белый глянец' },
      { Имя: 'Маршрут', Значение: 'Фрезеровка; облицовка' },
    ],
  },
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
    expect(sections.holesGeometry).toEqual([
      { x: 350, y: 0, z: 8, diameter: 5, depth: 12, type: 'Глухое', dirX: 0, dirY: 1, dirZ: 0 },
    ]);
    expect(sections.grooves).toHaveLength(1);
    expect(sections.operations).toHaveLength(1);
    expect(sections.operations[0]).toEqual(expect.arrayContaining([{ key: 'Код', value: 'cut16' }]));
    expect(sections.properties).toEqual([
      { key: 'Фрезеровка', value: 'Модерн' },
      { key: 'Пленка', value: 'Белый глянец' },
      { key: 'Маршрут', value: 'Фрезеровка; облицовка' },
    ]);
    expect(sections.scalars).toEqual(expect.arrayContaining([{ key: 'ТипОбъекта', value: 'Панель' }]));
    expect(sections.scalars.map((scalar) => scalar.key)).not.toContain('СписокКромок2');
  });

  it('supports legacy direct properties and single nested property objects', () => {
    expect(parseNodeRaw({
      ПользовательскиеСвойства: {
        Свойство: { Имя: 'Присадка', Значение: 'Присадка:' },
      },
      Свойство: [{ Наименование: 'Артикул', Значение: 'АБ-12' }],
    }).properties).toEqual([
      { key: 'Присадка', value: 'Присадка:' },
      { key: 'Артикул', value: 'АБ-12' },
    ]);
  });

  it('is resilient to missing/odd shapes', () => {
    expect(parseNodeRaw({})).toMatchObject({ edges: [], faces: [], holes: [], properties: [], operations: [] });
    expect(parseNodeRaw({
      СписокКромок1: 'мусор',
      ПользовательскиеСвойства: 'мусор',
      Свойство: [{ Имя: '', Значение: '' }],
    } as never)).toMatchObject({ edges: [], properties: [] });
  });
});

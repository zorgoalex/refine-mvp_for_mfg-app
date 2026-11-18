import { describe, expect, it } from 'vitest';
import { parseBazisXml } from '../application/bazis-xml-parser';
import {
  bazisReferenceLookupKey,
  buildDraftDetails,
  collectUnmappedMaterialNames,
  collectUnresolvedMillingNames,
  resolvePanelMillingTypeId,
  type BazisDraftMaterialMapping,
} from './bazis-order-draft';

const raw = (milling: string | null) => ({
  ПользовательскиеСвойства: {
    Свойство: milling == null ? [] : [{ Имя: 'Фрезировка', Значение: milling }],
  },
});

const panel = (milling: string | null, mainMaterialName = 'МДФ 16 мм') => ({
  bazisNodeId: 1,
  name: 'Фронтальная',
  position: 'В.8',
  designation: 'В.00.01',
  cumulativeQuantity: 1,
  lengthMm: 500,
  widthMm: 300,
  mainMaterialName,
  productName: 'Ванна',
  productOrderNo: '1721',
  rawJson: raw(milling),
});

const sheet: BazisDraftMaterialMapping = { target_kind: 'sheet', sheet_material_type_id: 5, film_id: null };
const catalog = new Map([[bazisReferenceLookupKey('milling', 'Модерн'), 1], [bazisReferenceLookupKey('milling', 'по фото/схеме'), 666]]);

describe('Bazis milling resolution (1721.xml: «Выборка по фото» silently became «модерн»)', () => {
  it('reports a milling missing from the catalog and mappings instead of defaulting to milling type 1', () => {
    const mappings = new Map([['sheet:мдф 16 мм', sheet]]);
    expect(resolvePanelMillingTypeId(raw('Выборка по фото'), mappings, catalog)).toBeUndefined();
    expect(collectUnresolvedMillingNames([panel('Выборка по фото'), panel('выборка  по ФОТО')], mappings, catalog))
      .toEqual(['выборка  по ФОТО']);
    expect(collectUnmappedMaterialNames([panel('Выборка по фото', 'ЛДСП')], mappings, catalog)).toEqual([
      'ЛДСП',
      'Выборка по фото (фрезеровка)',
    ]);
  });

  it('uses the user mapping first, «Пропустить» = default milling, otherwise the catalog name', () => {
    const mappings = new Map<string, BazisDraftMaterialMapping>([
      ['sheet:мдф 16 мм', sheet],
      ['milling:выборка по фото', { target_kind: 'milling', sheet_material_type_id: null, film_id: null, milling_type_id: 666 }],
      ['milling:выборка 2 ступ.', { target_kind: 'ignore', sheet_material_type_id: null, film_id: null, milling_type_id: null }],
      ['milling:модерн', { target_kind: 'milling', sheet_material_type_id: null, film_id: null, milling_type_id: 7 }],
    ]);
    expect(resolvePanelMillingTypeId(raw('Выборка по фото'), mappings, catalog)).toBe(666);
    expect(resolvePanelMillingTypeId(raw('Выборка 2 ступ.'), mappings, catalog)).toBe(1);
    expect(resolvePanelMillingTypeId(raw('Модерн'), mappings, catalog)).toBe(7);
    expect(resolvePanelMillingTypeId(raw('Модерн'), new Map(), catalog)).toBe(1);
    expect(resolvePanelMillingTypeId(raw(null), new Map(), new Map())).toBe(1);
    expect(collectUnmappedMaterialNames(
      [panel('Выборка по фото'), panel('Выборка 2 ступ.'), panel('Модерн'), panel(null)],
      mappings,
      catalog,
    )).toEqual([]);

    const details = buildDraftDetails(
      [panel('Выборка по фото'), panel('Модерн')],
      mappings,
      { bazisProjectName: 'X', revisionBazisOrderNo: '1721', rootProductCount: 1 },
      catalog,
    );
    expect(details.map((detail) => detail.millingTypeId)).toEqual([666, 7]);
  });

  it('finds the mapping for any spelling of the same milling, in any panel order (review R1 finding 2)', () => {
    const mapping: BazisDraftMaterialMapping = {
      target_kind: 'milling', sheet_material_type_id: null, film_id: null, milling_type_id: 666,
    };
    // Ключ карты сопоставлений — нормализованное имя (loadMaterialMappingsForPanels).
    const mappings = new Map([['sheet:мдф 16 мм', sheet], ['milling:выборка по фото', mapping]]);
    for (const order of [['Выборка по фото', 'Выборка  по  фото'], ['ВЫБОРКА  ПО ФОТО', 'Выборка по фото']]) {
      const panels = order.map((name) => panel(name));
      expect(collectUnmappedMaterialNames(panels, mappings, catalog)).toEqual([]);
      expect(
        buildDraftDetails(panels, mappings, { bazisProjectName: 'X', revisionBazisOrderNo: '1721', rootProductCount: 1 }, catalog)
          .map((detail) => detail.millingTypeId),
      ).toEqual([666, 666]);
    }
    expect(resolvePanelMillingTypeId(raw('Выборка по фото'), new Map(), new Map([[bazisReferenceLookupKey('milling', 'выборка   по фото')]].map(([key]) => [key, 3])))).toBe(3);
  });

  it('keeps the old fallback inside buildDraftDetails for callers that do not gate (cut export)', () => {
    const [detail] = buildDraftDetails(
      [panel('Выборка по фото')],
      new Map([['sheet:мдф 16 мм', sheet]]),
      { bazisProjectName: 'X', revisionBazisOrderNo: '1721', rootProductCount: 1 },
      catalog,
    );
    expect(detail?.millingTypeId).toBe(1);
  });
});

describe('parseBazisXml millings', () => {
  it('collects panel millings case-insensitively, separately from materials', () => {
    const parsed = parseBazisXml(`<Проект><Изделие><Наименование>Ванна</Наименование><СписокЭлементов>
      <Объект><ТипОбъекта>Панель</ТипОбъекта><ПользовательскиеСвойства>
        <Свойство><Имя>Фрезировка</Имя><Значение>Выборка по фото</Значение></Свойство></ПользовательскиеСвойства></Объект>
      <Объект><ТипОбъекта>Панель</ТипОбъекта><ПользовательскиеСвойства>
        <Свойство><Имя>Фрезеровка</Имя><Значение>выборка по фото</Значение></Свойство></ПользовательскиеСвойства></Объект>
      <Объект><ТипОбъекта>Панель</ТипОбъекта><ПользовательскиеСвойства>
        <Свойство><Имя>Фрезировка</Имя><Значение>Модерн</Значение></Свойство></ПользовательскиеСвойства></Объект>
      <Объект><ТипОбъекта>Фурнитура</ТипОбъекта><ПользовательскиеСвойства>
        <Свойство><Имя>Фрезировка</Имя><Значение>Не панель</Значение></Свойство></ПользовательскиеСвойства></Объект>
    </СписокЭлементов></Изделие></Проект>`);
    expect(parsed.millings).toEqual([
      { name: 'Выборка по фото', usageCount: 2 },
      { name: 'Модерн', usageCount: 1 },
    ]);
    expect(parsed.materials.some((material) => (material.kindGuess as string) === 'milling')).toBe(false);
    expect(parsed.summary.uniqueMaterials).toBe(0);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bazisPanelPropertyFilmName,
  bazisPanelUniqueFaceFilm,
  parseBazisFaceFilmName,
  stripBazisModelFileExtension,
} from './bazis-panel-film';
import { parseBazisXml } from './bazis-xml-parser';
import {
  bazisReferenceLookupKey,
  buildDraftDetails,
  panelFilmNameCandidates,
  panelLegacyLookupFilmName,
  panelLookupFilmName,
  panelPreferredFilmName,
} from '../adapters/bazis-order-draft';

const face = (...names: string[]) => ({ Пласть: names.map((name) => ({ Наименование: name })) });
const props = (...pairs: Array<[string, string]>) => ({
  Свойство: pairs.map(([Имя, Значение]) => ({ Имя, Значение })),
});

describe('parseBazisFaceFilmName', () => {
  it('keeps a plain (standard Bazis export) name as is, trimming only the edges', () => {
    expect(parseBazisFaceFilmName('  AL 31  Белый мат ')).toEqual({
      name: 'AL 31  Белый мат',
      filmPart: 'AL 31  Белый мат',
      withVendor: false,
    });
  });

  it('joins the vendor line of the facade export with "; " (ERP film catalog format)', () => {
    for (const separator of ['\n', '\r', '\r\n', ' \n  ']) {
      expect(parseBazisFaceFilmName(`Белая глянцевая (0,45) пленка SY 06-02${separator}ADILET`)).toEqual({
        name: 'Белая глянцевая (0,45) пленка SY 06-02; ADILET',
        filmPart: 'Белая глянцевая (0,45) пленка SY 06-02',
        withVendor: true,
      });
    }
  });

  it('returns null for empty values', () => {
    expect(parseBazisFaceFilmName('  \n ')).toBeNull();
    expect(parseBazisFaceFilmName(undefined)).toBeNull();
  });
});

describe('bazisPanelPropertyFilmName', () => {
  it('upgrades the property film to the face film with vendor when the names match', () => {
    const raw = {
      ОблицовкаПласти1: face('Шагрень черный\nDECOR +'),
      ПользовательскиеСвойства: props(['Пленка', 'шагрень  черный']),
    };
    expect(bazisPanelPropertyFilmName(raw)).toBe('Шагрень черный; DECOR +');
  });

  it('keeps the property film when the face film is a different one', () => {
    const raw = {
      ОблицовкаПласти1: face('Шагрень белый\nDECOR +'),
      ПользовательскиеСвойства: props(['Пленка', 'Шагрень черный']),
    };
    expect(bazisPanelPropertyFilmName(raw)).toBe('Шагрень черный');
  });

  it('never upgrades from a face film without vendor (standard export stays unchanged)', () => {
    const raw = {
      ОблицовкаПласти1: face('Шагрень черный'),
      ПользовательскиеСвойства: props(['Пленка', 'Шагрень черный']),
    };
    expect(bazisPanelPropertyFilmName(raw)).toBe('Шагрень черный');
  });

  it('formats a vendor written into the property value itself', () => {
    const raw = { ПользовательскиеСвойства: props(['Пленка', 'Белая глянцевая\r\nADILET']) };
    expect(bazisPanelPropertyFilmName(raw)).toBe('Белая глянцевая; ADILET');
  });

  it('falls back to «Пленка (обр)», «Пленка» wins when both are set', () => {
    expect(
      bazisPanelPropertyFilmName({
        ОблицовкаПласти1: face('Шпон орех\nЕвразия Декор'),
        ПользовательскиеСвойства: props(['Пленка (обр)', 'Шпон орех']),
      }),
    ).toBe('Шпон орех; Евразия Декор');
    expect(
      bazisPanelPropertyFilmName({
        ПользовательскиеСвойства: props(['Пленка (обр)', 'Шпон орех'], ['Пленка', 'Дуб']),
      }),
    ).toBe('Дуб');
  });
});

describe('order draft film selection', () => {
  it('uses the unique face film with vendor for the reference lookup, plain face film only via mapping', () => {
    const withVendor = { ОблицовкаПласти1: face('Шпон орех\nЕвразия Декор') };
    const plain = { ОблицовкаПласти1: face('Шпон орех') };
    expect(panelPreferredFilmName(withVendor)).toBe('Шпон орех; Евразия Декор');
    expect(panelLookupFilmName(withVendor)).toBe('Шпон орех; Евразия Декор');
    expect(panelPreferredFilmName(plain)).toBe('Шпон орех');
    expect(panelLookupFilmName(plain)).toBeNull();
    expect(bazisPanelUniqueFaceFilm({ ОблицовкаПласти1: face('A'), ОблицовкаПласти2: face('B') })).toBeNull();
  });

  it('finds the ERP film «Название; Поставщик» for a facade export panel', () => {
    const [detail] = buildDraftDetails(
      [
        {
          bazisNodeId: 1,
          name: 'Фасад',
          position: '1',
          designation: '1',
          cumulativeQuantity: 1,
          lengthMm: 500,
          widthMm: 300,
          mainMaterialName: 'МДФ 16 мм',
          productName: 'Тумба',
          productOrderNo: '1730',
          rawJson: {
            ОблицовкаПласти1: face('Белая глянцевая (0,45) пленка SY 06-02\rADILET'),
            ПользовательскиеСвойства: props(['Пленка (обр)', 'Белая глянцевая (0,45) пленка SY 06-02']),
          },
        },
      ],
      new Map(),
      { bazisProjectName: 'X', revisionBazisOrderNo: '1730', rootProductCount: 1 },
      new Map([[bazisReferenceLookupKey('film', 'Белая глянцевая (0,45) пленка SY 06-02; ADILET'), 5958]]),
    );
    expect(detail?.filmId).toBe(5958);
  });
});

describe('mappings saved before «Название; Поставщик» (review R1 finding 1)', () => {
  const draft = (
    rawJson: Record<string, unknown>,
    mappings: Array<[string, { target_kind: string; film_id: number | null }]>,
    lookup: Array<[string, number]> = [],
  ) =>
    buildDraftDetails(
      [
        {
          bazisNodeId: 1, name: 'Фасад', position: '1', designation: '1', cumulativeQuantity: 1,
          lengthMm: 500, widthMm: 300, mainMaterialName: 'МДФ 16 мм', productName: 'Тумба',
          productOrderNo: '1730', rawJson,
        },
      ],
      new Map(mappings.map(([key, value]) => [key, { ...value, sheet_material_type_id: null }])),
      { bazisProjectName: 'X', revisionBazisOrderNo: '1730', rootProductCount: 1 },
      new Map(lookup),
    )[0];

  const propertyAndFace = {
    ОблицовкаПласти1: face('Шагрень черный\nDECOR +'),
    ПользовательскиеСвойства: props(['Пленка', 'Шагрень черный']),
  };

  it('keeps a saved film mapping and a saved «Пропустить» of the old name without vendor', () => {
    expect(panelFilmNameCandidates(propertyAndFace)).toEqual(['Шагрень черный; DECOR +', 'Шагрень черный']);
    expect(draft(propertyAndFace, [['film:шагрень черный', { target_kind: 'film', film_id: 41 }]])?.filmId).toBe(41);
    expect(
      draft(
        propertyAndFace,
        [['film:шагрень черный', { target_kind: 'ignore', film_id: null }]],
        [[bazisReferenceLookupKey('film', 'Шагрень черный; DECOR +'), 99]],
      )?.filmId,
    ).toBeNull();
  });

  it('a new mapping of the vendor name wins over the old one', () => {
    expect(
      draft(propertyAndFace, [
        ['film:шагрень черный; decor +', { target_kind: 'film', film_id: 42 }],
        ['film:шагрень черный', { target_kind: 'film', film_id: 41 }],
      ])?.filmId,
    ).toBe(42);
  });

  it('keeps the old raw face name (with the line break) as a mapping candidate', () => {
    const faceOnly = { ОблицовкаПласти1: face('Шпон орех\nЕвразия Декор') };
    expect(panelFilmNameCandidates(faceOnly)).toEqual(['Шпон орех; Евразия Декор', 'Шпон орех\nЕвразия Декор']);
    expect(draft(faceOnly, [['film:шпон орех евразия декор', { target_kind: 'film', film_id: 7 }]])?.filmId).toBe(7);
  });

  it('falls back to the catalog film without vendor when «Название; Поставщик» is not in the catalog', () => {
    expect(
      draft(propertyAndFace, [], [[bazisReferenceLookupKey('film', 'Шагрень черный'), 55]])?.filmId,
    ).toBe(55);
    expect(panelLegacyLookupFilmName(propertyAndFace)).toBe('Шагрень черный');
  });
});

describe('stripBazisModelFileExtension', () => {
  it('drops the .b3d model file extension only', () => {
    expect(stripBazisModelFileExtension('Радиусная вытяжка.b3d')).toBe('Радиусная вытяжка');
    expect(stripBazisModelFileExtension('ТВ тумба.B3D ')).toBe('ТВ тумба');
    expect(stripBazisModelFileExtension('Кухня')).toBe('Кухня');
    expect(stripBazisModelFileExtension('.b3d')).toBe('.b3d');
    expect(stripBazisModelFileExtension(null)).toBeNull();
  });
});

describe('facade export XML («Экспорт фасадов 1»)', () => {
  const parsed = parseBazisXml(
    readFileSync(new URL('./__fixtures__/bazis-facade-export-sample.xml', import.meta.url)),
  );

  it('parses the reduced facade export like the standard one', () => {
    expect(parsed.bazisVersion).toBe('Экспорт фасадов 1');
    expect(parsed.bazisOrderNo).toBe('1730');
    expect(parsed.designEngineerName).toBeNull();
    expect(parsed.productPrice).toBeNull();
    expect(parsed.summary).toMatchObject({ totalNodes: 10, panels: 9, hardware: 0, assemblies: 0 });
    const holes = parsed.nodes.reduce((sum, node) => {
      const container = node.raw['Отверстия'] as Record<string, unknown> | undefined;
      const list = container?.['Отверстие'];
      return sum + (Array.isArray(list) ? list.length : 0);
    }, 0);
    expect(holes).toBe(72);
  });

  it('records films as «Название; Поставщик» for material mapping', () => {
    const films = parsed.materials.filter((material) => material.kindGuess === 'film');
    expect(films).toEqual([
      { name: 'Шпон орех натур софт ZB 254-SFT_0.18*1260, пог. м; Евразия Декор', kindGuess: 'film', usageCount: 5 },
      { name: 'Белая глянцевая (0,45) пленка SY 06-02; ADILET', kindGuess: 'film', usageCount: 1 },
    ]);
    expect(films.every((film) => !/[\r\n]/.test(film.name))).toBe(true);
  });
});

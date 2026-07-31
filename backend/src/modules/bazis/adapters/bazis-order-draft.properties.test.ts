import { describe, expect, it } from 'vitest';
import {
  bazisReferenceLookupKey,
  buildDraftDetails,
  type BazisDraftMaterialMapping,
} from './bazis-order-draft';

const panel = (rawJson: Record<string, unknown> | null) => ({
  bazisNodeId: 701,
  name: 'Фасад',
  position: '1',
  designation: '11.02',
  cumulativeQuantity: 2,
  lengthMm: 500,
  widthMm: 300,
  mainMaterialName: 'МДФ 16 мм',
  productName: 'Кухня',
  productOrderNo: '1457',
  rawJson,
});

const revision = {
  bazisProjectName: 'proj.xml',
  revisionBazisOrderNo: '1457',
};

const filmMapping = (filmId: number): BazisDraftMaterialMapping => ({
  target_kind: 'film',
  sheet_material_type_id: null,
  film_id: filmId,
});

describe('buildDraftDetails user property priority', () => {
  it('takes milling and film from nested user properties before face coating', () => {
    const rawJson = {
      ОблицовкаПласти1: { Пласть: [{ Наименование: 'Старая плёнка' }] },
      ПользовательскиеСвойства: {
        Свойство: [
          { Имя: 'Фрезировка', Значение: 'Модерн' },
          { Имя: 'Плёнка', Значение: 'Белый глянец' },
        ],
      },
    };
    const mappings = new Map<string, BazisDraftMaterialMapping>([
      ['film:старая пленка', filmMapping(601)],
      ['film:белый глянец', filmMapping(777)],
    ]);
    const references = new Map([
      [bazisReferenceLookupKey('milling', 'Модерн'), 42],
      [bazisReferenceLookupKey('film', 'Белый глянец'), 778],
    ]);

    const [detail] = buildDraftDetails([panel(rawJson)], mappings, revision, references);

    expect(detail).toMatchObject({
      filmId: 777,
      millingTypeId: 42,
    });
  });

  it('resolves legacy direct properties against ERP reference names', () => {
    const rawJson = {
      Свойство: [
        { Наименование: 'ФРЕЗЕРОВКА', Значение: '  Классика  ' },
        { Наименование: 'ПЛЁНКА', Значение: '  Белый   матовый  ' },
      ],
    };
    const references = new Map([
      [bazisReferenceLookupKey('milling', 'классика'), 43],
      [bazisReferenceLookupKey('film', 'белый матовый'), 779],
    ]);

    const [detail] = buildDraftDetails([panel(rawJson)], new Map(), revision, references);

    expect(detail).toMatchObject({
      filmId: 779,
      millingTypeId: 43,
    });
  });

  it('keeps old face coating behavior only when custom film property is absent', () => {
    const mappings = new Map<string, BazisDraftMaterialMapping>([
      ['film:старая пленка', filmMapping(601)],
    ]);

    const [legacyDetail] = buildDraftDetails(
      [panel({ ОблицовкаПласти1: { Пласть: [{ Наименование: 'Старая плёнка' }] } })],
      mappings,
      revision,
    );
    const [customUnknownDetail] = buildDraftDetails(
      [
        panel({
          ОблицовкаПласти1: { Пласть: [{ Наименование: 'Старая плёнка' }] },
          ПользовательскиеСвойства: {
            Свойство: { Имя: 'Пленка', Значение: 'Неизвестная плёнка' },
          },
        }),
      ],
      mappings,
      revision,
    );

    expect(legacyDetail).toMatchObject({ filmId: 601, millingTypeId: 1 });
    expect(customUnknownDetail).toMatchObject({ filmId: null, millingTypeId: 1 });
  });
});

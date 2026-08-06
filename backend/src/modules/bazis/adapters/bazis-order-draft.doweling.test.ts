import { describe, expect, it } from 'vitest';
import { buildDraftDetails, panelHasDrilling, panelHasRoute } from './bazis-order-draft';

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
  rootProductCount: 1,
};

describe('panelHasDrilling', () => {
  it('detects holes in the «Отверстия»->«Отверстие» container', () => {
    expect(panelHasDrilling({ Отверстия: { Отверстие: [{ Диаметр: '5' }] } })).toBe(true);
  });

  it('detects holes in the direct «Отверстие» array (fallback, mirrors parseNodeRaw)', () => {
    expect(panelHasDrilling({ Отверстие: [{ Диаметр: '8' }] })).toBe(true);
  });

  it.each([
    [null],
    [{}],
    [{ Отверстия: {} }],
    [{ Отверстия: { Отверстие: [] } }],
    [{ Отверстие: [] }],
    [{ Отверстия: 'мусор' }],
  ])('returns false for %j', (rawJson) => {
    expect(panelHasDrilling(rawJson as Record<string, unknown> | null)).toBe(false);
  });
});

describe('panelHasRoute', () => {
  it('detects a non-empty nested «Маршрут» property case-insensitively', () => {
    expect(panelHasRoute({
      ПользовательскиеСвойства: {
        Свойство: { Имя: 'МАРШРУТ', Значение: '  Присадка:  ' },
      },
    })).toBe(true);
  });

  it('supports legacy direct properties and rejects an empty route', () => {
    expect(panelHasRoute({
      Свойство: { Наименование: 'Маршрут', Значение: 'Присадка:' },
    })).toBe(true);
    expect(panelHasRoute({
      ПользовательскиеСвойства: {
        Свойство: { Имя: 'Маршрут', Значение: '   ' },
      },
    })).toBe(false);
  });
});

describe('buildDraftDetails doweling', () => {
  it('sets doweling=true for holes or a non-empty route', () => {
    const details = buildDraftDetails(
      [
        panel({ Отверстия: { Отверстие: [{ Диаметр: '5' }] } }),
        {
          ...panel({
            ПользовательскиеСвойства: {
              Свойство: { Имя: 'Маршрут', Значение: 'Присадка:' },
            },
          }),
          bazisNodeId: 702,
        },
        {
          ...panel({
            ПользовательскиеСвойства: {
              Свойство: { Имя: 'Маршрут', Значение: '' },
            },
          }),
          bazisNodeId: 703,
        },
      ],
      new Map(),
      revision,
    );

    expect(details.map((detail) => detail.doweling)).toEqual([true, true, false]);
  });
});

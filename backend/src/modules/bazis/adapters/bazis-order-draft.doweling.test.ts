import { describe, expect, it } from 'vitest';
import { buildDraftDetails, panelHasDrilling } from './bazis-order-draft';

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

describe('buildDraftDetails doweling', () => {
  it('sets doweling=true only for panels with holes', () => {
    const details = buildDraftDetails(
      [
        panel({ Отверстия: { Отверстие: [{ Диаметр: '5' }] } }),
        { ...panel(null), bazisNodeId: 702 },
      ],
      new Map(),
      revision,
    );

    expect(details.map((detail) => detail.doweling)).toEqual([true, false]);
  });
});

import { describe, expect, it } from 'vitest';
import { buildDraftDetails } from './bazis-order-draft';

const revision = {
  bazisProjectName: 'project.xml',
  revisionBazisOrderNo: '1500',
};

describe('buildDraftDetails panel dimensions', () => {
  it('rounds legacy fractional dimensions with the same half-up rule as XML import', () => {
    const basePanel = {
      name: 'Панель',
      position: '1',
      designation: 'A',
      cumulativeQuantity: 1,
      mainMaterialName: null,
      productName: 'Шкаф',
      productOrderNo: '1500',
      rawJson: null,
    };

    const details = buildDraftDetails(
      [
        { ...basePanel, bazisNodeId: 1, lengthMm: 719.49, widthMm: 400.49 },
        { ...basePanel, bazisNodeId: 2, lengthMm: 719.5, widthMm: 400.5 },
      ],
      new Map(),
      revision,
    );

    expect(details.map(({ height, width }) => ({ height, width }))).toEqual([
      { height: 719, width: 400 },
      { height: 720, width: 401 },
    ]);
  });
});

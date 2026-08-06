import { describe, expect, it } from 'vitest';
import { buildDraftDetails } from './bazis-order-draft';

const panel = {
  bazisNodeId: 101,
  name: 'Фасад',
  position: '7',
  designation: 'D-01',
  cumulativeQuantity: 1,
  lengthMm: 700,
  widthMm: 400,
  mainMaterialName: null,
  productName: '  Шкаф  ',
  productOrderNo: '1443',
  rawJson: null,
};

describe('buildDraftDetails Basis product mapping', () => {
  it('leaves Basis product empty when the panels table hides the only root product', () => {
    const [detail] = buildDraftDetails([panel], new Map(), {
      bazisProjectName: 'project.xml',
      revisionBazisOrderNo: '1443',
      rootProductCount: 1,
    });

    expect(detail?.basisProduct).toBeNull();
  });

  it('uses the panel root product when the project contains several products', () => {
    const [detail] = buildDraftDetails([panel], new Map(), {
      bazisProjectName: 'project.xml',
      revisionBazisOrderNo: '1443',
      rootProductCount: 2,
    });

    expect(detail?.basisProduct).toBe('Шкаф');
  });
});

import { describe, expect, it } from 'vitest';
import { resolveOrderListBasisProjectValues } from './orderListBasisProjects';

describe('resolveOrderListBasisProjectValues', () => {
  it('keeps the order doweling name when it is filled', () => {
    expect(resolveOrderListBasisProjectValues({
      dowelingOrderName: '  П-104  ',
      basisProjects: ['1491', '1492'],
      details: [{ basis_project: '1493' }],
    })).toEqual(['П-104']);
  });

  it('uses unique trimmed detail Basis projects when doweling is empty', () => {
    expect(resolveOrderListBasisProjectValues({
      dowelingOrderName: '   ',
      details: [
        { basis_project: ' 1491 ' },
        { basisProject: '1492' },
        { basis_project: '1491' },
        { basis_project: '' },
        { basis_project: null },
      ],
    })).toEqual(['1491', '1492']);
  });

  it('uses the backend aggregate before legacy details and deduplicates case-insensitively', () => {
    expect(resolveOrderListBasisProjectValues({
      dowelingOrderName: null,
      basisProjects: [' Проект A ', 'проект a', 'Проект B'],
      details: [{ basis_project: 'legacy' }],
    })).toEqual(['Проект A', 'Проект B']);
  });

  it('returns an empty list when neither source has a value', () => {
    expect(resolveOrderListBasisProjectValues({
      dowelingOrderName: null,
      basisProjects: [],
      details: [{ basis_project: null }],
    })).toEqual([]);
  });
});

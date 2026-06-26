import { describe, expect, it } from 'vitest';
import { collectOrderBasisProjects } from './orderBasisProjects';

describe('collectOrderBasisProjects', () => {
  it('returns trimmed unique Basis project values in detail order', () => {
    expect(
      collectOrderBasisProjects([
        { basis_project: ' № 020 / Respublika ' },
        { basisProject: '№ 020 / Respublika' },
        { basis_project: '' },
        { basisProject: null },
        { basis_project: 'MDF-16-mm-2' },
      ]),
    ).toEqual(['№ 020 / Respublika', 'MDF-16-mm-2']);
  });
});

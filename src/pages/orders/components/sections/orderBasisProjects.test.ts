import { describe, expect, it } from 'vitest';
import { collectOrderBasisProjects, resolveOrderBasisProject } from './orderBasisProjects';

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

  it('uses the linked current name instead of the imported snapshot', () => {
    const detail = { basis_project: 'Старое имя', bazis_project_id: 7,
      bazis_projects: [{ bazisProjectId: 7, name: 'Новое имя Әлия' }] };
    expect(resolveOrderBasisProject(detail)).toEqual({ name: 'Новое имя Әлия', projectId: 7 });
    expect(collectOrderBasisProjects([detail, detail])).toEqual(['Новое имя Әлия']);
    expect(detail.basis_project).toBe('Старое имя');
  });

  it('matches names to the linked id, not the first unrelated reference', () => {
    const detail = { basis_project: 'Ручное значение', bazis_project_id: 7,
      bazis_projects: [{ bazisProjectId: 3, name: 'Другой' }, { bazisProjectId: 7, name: 'Текущий' }] };
    expect(resolveOrderBasisProject(detail)).toEqual({ name: 'Текущий', projectId: 7 });
    expect(resolveOrderBasisProject({ ...detail, bazis_project_id: 99 })).toEqual({ name: 'Ручное значение', projectId: 99 });
  });

  it('supports camelCase API rows and unlinked/manual details', () => {
    expect(resolveOrderBasisProject({ basisProject: 'old', bazisProjects: [{ bazisProjectId: 2, name: 'Новое' }] }))
      .toEqual({ name: 'Новое', projectId: 2 });
    expect(resolveOrderBasisProject({ basis_project: '  Ручное  ' })).toEqual({ name: 'Ручное', projectId: null });
  });
});

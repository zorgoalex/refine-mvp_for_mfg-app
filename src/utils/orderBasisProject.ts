export type DetailWithBasisProject = {
  basis_project?: unknown;
  basisProject?: unknown;
  bazis_project_id?: unknown;
  bazisProjectId?: unknown;
  bazis_projects?: unknown;
  bazisProjects?: unknown;
};

const positiveId = (value: unknown): number | null => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

/** Display only: preserve the imported snapshot because legacy linkage can depend on it. */
export function resolveOrderBasisProject(detail: DetailWithBasisProject): { name: string; projectId: number | null } {
  const explicitId = positiveId(detail.bazis_project_id ?? detail.bazisProjectId);
  const rawRefs = detail.bazis_projects ?? detail.bazisProjects;
  const refs = Array.isArray(rawRefs) ? rawRefs.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const id = positiveId(value.bazisProjectId);
    return id ? [{ id, name: typeof value.name === 'string' ? value.name.trim() : '' }] : [];
  }) : [];
  const linked = explicitId ? refs.find(ref => ref.id === explicitId) : refs[0];
  const rawName = detail.basis_project ?? detail.basisProject;
  const fallback = typeof rawName === 'string' || typeof rawName === 'number' ? String(rawName).trim() : '';
  return { name: linked?.name || fallback, projectId: explicitId ?? linked?.id ?? null };
}

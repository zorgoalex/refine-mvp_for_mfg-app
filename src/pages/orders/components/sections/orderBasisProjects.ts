type DetailWithBasisProject = {
  basis_project?: unknown;
  basisProject?: unknown;
};

export function collectOrderBasisProjects(details: readonly DetailWithBasisProject[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const detail of details) {
    const raw = detail.basis_project ?? detail.basisProject;
    if (raw === null || raw === undefined) continue;

    const value = String(raw).trim();
    if (!value || seen.has(value)) continue;

    seen.add(value);
    result.push(value);
  }

  return result;
}

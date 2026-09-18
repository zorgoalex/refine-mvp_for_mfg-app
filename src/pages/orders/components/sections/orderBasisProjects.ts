import { resolveOrderBasisProject, type DetailWithBasisProject } from '../../../../utils/orderBasisProject';
export { resolveOrderBasisProject } from '../../../../utils/orderBasisProject';

export function collectOrderBasisProjects(details: readonly DetailWithBasisProject[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const detail of details) {
    const value = resolveOrderBasisProject(detail).name;
    if (!value || seen.has(value)) continue;

    seen.add(value);
    result.push(value);
  }

  return result;
}

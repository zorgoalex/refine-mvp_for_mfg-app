/**
 * «NewLine»: поиск, отбор по связи с заказом и сводка списка Базис-проектов.
 * Список приходит целиком одним запросом, поэтому всё считается на клиенте.
 */
import type { BazisProjectListItem } from '../../api/types/bazisApi.types';

export type BazisLinkChoice = 'all' | 'linked' | 'free';

export const BAZIS_LINK_CHOICES: ReadonlyArray<{ value: BazisLinkChoice; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'linked', label: 'Связаны с заказом' },
  { value: 'free', label: 'Не связаны' },
];

export function bazisProjectSearchText(project: BazisProjectListItem): string {
  return [
    project.name,
    project.bazisOrderNo,
    project.projectName,
    `#${project.projectId}`,
    project.designEngineerName,
    ...project.linkedOrders.map((order) => order.orderName),
    ...project.linkedOrderIds.map((id) => `#${id}`),
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ')
    .toLocaleLowerCase('ru');
}

export function filterBazisProjects<T extends BazisProjectListItem>(
  projects: readonly T[],
  query: string,
  link: BazisLinkChoice,
): T[] {
  const needle = query.trim().toLocaleLowerCase('ru');
  return projects.filter((project) => {
    const linked = project.linkedOrderIds.length > 0;
    if (link === 'linked' && !linked) return false;
    if (link === 'free' && linked) return false;
    return !needle || bazisProjectSearchText(project).includes(needle);
  });
}

/** Самый свежий импорт по всем проектам; `null`, если дат нет или они не разбираются. */
export function latestBazisImport(projects: readonly BazisProjectListItem[]): Date | null {
  let latest: Date | null = null;
  projects.forEach((project) => {
    if (!project.lastImportedAt) return;
    const date = new Date(project.lastImportedAt);
    if (Number.isNaN(date.getTime())) return;
    if (!latest || date > latest) latest = date;
  });
  return latest;
}

export function bazisProjectsCountLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11
    ? 'проект'
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
      ? 'проекта'
      : 'проектов';
  return `${count} ${word}`;
}

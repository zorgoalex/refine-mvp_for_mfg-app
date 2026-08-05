export interface BazisEmployeeCandidate {
  employeeId: number;
  fullName: string;
}

/**
 * Сопоставляет имя из Базис XML со справочником сотрудников.
 * Приоритет: точное ФИО, затем уникальная фамилия + инициалы.
 * Неоднозначное совпадение намеренно возвращает null.
 */
export function matchBazisDesignEngineer(
  xmlName: string | null,
  employees: readonly BazisEmployeeCandidate[],
): BazisEmployeeCandidate | null {
  const source = tokenizeName(xmlName);
  if (!source) {
    return null;
  }

  const candidates = employees
    .map((employee) => ({ employee, tokens: tokenizeName(employee.fullName) }))
    .filter((entry): entry is { employee: BazisEmployeeCandidate; tokens: string[] } => entry.tokens !== null);
  const exact = candidates.filter((entry) => entry.tokens.join(' ') === source.join(' '));
  if (exact.length === 1) {
    return exact[0].employee;
  }
  if (exact.length > 1) {
    return null;
  }

  const surname = source[0];
  const initials = source.slice(1).map((token) => token[0]).filter(Boolean);
  if (!surname || initials.length === 0) {
    return null;
  }
  const byInitials = candidates.filter(({ tokens }) =>
    tokens[0] === surname
      && initials.every((initial, index) => {
        const employeeToken = tokens[index + 1];
        // В справочнике часто хранится только «Фамилия Имя», а XML отдаёт
        // ещё и инициал отчества. Отсутствующее отчество не дисквалифицирует
        // совпадение, но имеющееся обязано совпасть.
        return employeeToken == null ? index > 0 : employeeToken[0] === initial;
      }),
  );
  return byInitials.length === 1 ? byInitials[0].employee : null;
}

function tokenizeName(value: string | null): string[] | null {
  if (!value) {
    return null;
  }
  const tokens = value
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return tokens.length > 0 ? tokens : null;
}

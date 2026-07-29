export interface OrderListBasisProjectDetail {
  basis_project?: unknown;
  basisProject?: unknown;
}

export interface ResolveOrderListBasisProjectValuesInput {
  dowelingOrderName?: unknown;
  basisProjects?: readonly unknown[] | null;
  details?: readonly OrderListBasisProjectDetail[] | null;
}

export function resolveOrderListBasisProjectValues(
  input: ResolveOrderListBasisProjectValuesInput,
): string[] {
  const dowelingOrderName = normalizeDisplayValue(input.dowelingOrderName);
  if (dowelingOrderName) return [dowelingOrderName];

  const backendValues = uniqueDisplayValues(input.basisProjects ?? []);
  if (backendValues.length > 0) return backendValues;

  return uniqueDisplayValues(
    (input.details ?? []).map((detail) => detail.basis_project ?? detail.basisProject),
  );
}

function uniqueDisplayValues(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  values.forEach((value) => {
    const normalized = normalizeDisplayValue(value);
    if (!normalized) return;

    const uniqueKey = normalized.toLocaleLowerCase('ru-RU');
    if (seen.has(uniqueKey)) return;

    seen.add(uniqueKey);
    result.push(normalized);
  });

  return result;
}

function normalizeDisplayValue(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

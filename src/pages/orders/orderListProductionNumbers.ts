export function normalizeOrderListProductionNumbers(values: unknown): string[] {
  if (!Array.isArray(values)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const text = stripSimpleCutResultSuffix(String(value).trim());
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }

  return normalized;
}

function stripSimpleCutResultSuffix(value: string): string {
  const match = value.match(/^(В-\d+|\d+)-\d+$/);
  return match?.[1] ?? value;
}

export function getDowelingOrderShowPath(dowelingOrderId: unknown): string | null {
  const parsedId = parseDowelingOrderId(dowelingOrderId);
  if (parsedId === null) return null;

  return `/doweling-orders/show/${parsedId}`;
}

function parseDowelingOrderId(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const numericValue = Number(trimmed);
    return Number.isInteger(numericValue) && numericValue > 0 ? numericValue : null;
  }

  return null;
}

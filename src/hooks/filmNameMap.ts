/** ID плёнок, отсутствующие в карте названий (уникальные, по возрастанию, не более 500). */
export function missingFilmIds(
  names: ReadonlyMap<number, string>,
  filmIds: ReadonlyArray<number | null | undefined>,
): number[] {
  const missing = new Set<number>();
  for (const id of filmIds) {
    if (id === null || id === undefined) continue;
    const value = Number(id);
    if (!Number.isSafeInteger(value) || value <= 0 || names.has(value)) continue;
    missing.add(value);
  }
  return [...missing].sort((a, b) => a - b).slice(0, 500);
}

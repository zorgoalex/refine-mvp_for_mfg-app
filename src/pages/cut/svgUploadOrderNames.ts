/** Source order labels are independent of stale names in the uploaded filename. */
export function svgUploadOrderNames(
  items: ReadonlyArray<{ orderName: string; detailNumber?: number | null }>,
  fileNameOrders: readonly string[],
): string[] {
  return [...new Set([
    ...items.filter(item => Number.isInteger(item.detailNumber) && Number(item.detailNumber) > 0).map(item => item.orderName),
    ...fileNameOrders,
  ].map(name => name.trim()).filter(Boolean))];
}

/**
 * The warning names every order that was not found, in quotes, and which of them came only from the file name
 * (not from any part label), so the user sees exactly what the upload could not find and where it read it.
 */
export function missingSvgOrdersWarning(missingOrderNames: readonly string[], fileNameOnlyOrders: readonly string[]): string {
  const quote = (name: string) => `«${name}»`;
  const names = missingOrderNames.map(quote).join(', ');
  const fileNameOnly = new Set(fileNameOnlyOrders);
  const fromFileName = missingOrderNames.filter(name => fileNameOnly.has(name)).map(quote);
  const head = missingOrderNames.length === 1 ? `Не найден заказ ${names} из SVG` : `Не найдены заказы ${names} из SVG`;
  return fromFileName.length > 0 ? `${head} (из имени файла: ${fromFileName.join(', ')})` : head;
}

/** File name orders that no part label of the SVG names. */
export function svgFileNameOnlyOrderNames(
  items: ReadonlyArray<{ orderName: string; detailNumber?: number | null }>,
  fileNameOrders: readonly string[],
): string[] {
  const labelled = new Set(svgUploadOrderNames(items, []));
  return fileNameOrders.map(name => name.trim()).filter(name => name && !labelled.has(name));
}

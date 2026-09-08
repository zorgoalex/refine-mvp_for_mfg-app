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

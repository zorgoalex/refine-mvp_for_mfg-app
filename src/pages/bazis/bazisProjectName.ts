export function suggestBazisProjectName(
  bazisOrderNo: string | null | undefined,
  fileName: string | null | undefined,
): string {
  const orderName = bazisOrderNo?.trim();
  if (orderName) return orderName;

  return (fileName ?? '').replace(/\.xml$/i, '').trim();
}

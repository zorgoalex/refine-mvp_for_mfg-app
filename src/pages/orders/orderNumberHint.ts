// Recommended order number: only digits, at least 4 (e.g. 3160). Such a number is read reliably everywhere the
// order is recognised by its number (SVG cut labels, Telegram, scans). Other names stay accepted; the hint is
// advisory and never blocks saving.
export const ORDER_NUMBER_HINT = 'Номер заказа — только цифры, не меньше 4 (например, 3160)';

export function isRecommendedOrderNumber(value: string | null | undefined): boolean {
  return /^\d{4,}$/.test(String(value ?? '').trim());
}

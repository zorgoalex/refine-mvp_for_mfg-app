/** Order delivery and production start shift: options and labels (form, card). Limits match the backend. */
export const ORDER_DELIVERY_ADDRESS_MAX = 500;
export const ORDER_DELIVERY_NOTES_MAX = 1000;

export const orderDeliveryMethodOptions: Array<{ value: 'courier' | 'pickup'; label: string }> = [
  { value: 'courier', label: 'Курьер' },
  { value: 'pickup', label: 'Самовывоз' },
];

export const orderStartShiftOptions = [1, 2, 3].map((shift) => ({ value: shift, label: `${shift} смена` }));

export function orderDeliveryMethodLabel(method: string | null | undefined): string | null {
  return orderDeliveryMethodOptions.find((option) => option.value === method)?.label ?? null;
}

export function orderStartShiftLabel(shift: number | null | undefined): string | null {
  return shift === 1 || shift === 2 || shift === 3 ? `${shift} смена` : null;
}

/** One line for the order card: «Курьер · ул. Абая 1 · 2 смена»; null when nothing is set. */
export function orderDeliverySummary(header: {
  delivery_method?: string | null;
  delivery_address?: string | null;
  start_shift?: number | null;
}): string | null {
  const parts = [
    orderDeliveryMethodLabel(header.delivery_method),
    header.delivery_address?.trim() || null,
    orderStartShiftLabel(header.start_shift),
  ].filter((part): part is string => !!part);
  return parts.length ? parts.join(' · ') : null;
}

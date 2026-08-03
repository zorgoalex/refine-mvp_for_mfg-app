export const ORDER_DETAIL_INLINE_TAB_FIELD_KEYS = [
  'height',
  'width',
  'quantity',
  'milling_type_id',
  'edge_type_id',
  'sheet_material_type_id',
  'note',
  'doweling',
  'milling_cost_per_sqm',
  'detail_cost',
  'film_id',
] as const;

const ORDER_DETAIL_INLINE_TAB_FIELD_KEY_SET = new Set<string>(
  ORDER_DETAIL_INLINE_TAB_FIELD_KEYS,
);

interface OrderDetailInlineTabFieldsOptions {
  detailCostEditable: boolean;
}

export function orderDetailInlineTabFields(
  visibleColumnKeys: readonly string[],
  { detailCostEditable }: OrderDetailInlineTabFieldsOptions,
): string[] {
  return visibleColumnKeys.filter((key) =>
    ORDER_DETAIL_INLINE_TAB_FIELD_KEY_SET.has(key)
    && (key !== 'detail_cost' || detailCostEditable),
  );
}

export function nextOrderDetailInlineTabField(
  fieldKeys: readonly string[],
  currentField: string,
  backwards: boolean,
): string | null {
  const currentIndex = fieldKeys.indexOf(currentField);
  if (currentIndex < 0) return null;
  return fieldKeys[currentIndex + (backwards ? -1 : 1)] ?? null;
}

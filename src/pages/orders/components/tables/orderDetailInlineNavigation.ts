export const ORDER_DETAIL_INLINE_TAB_FIELD_KEYS = [
  'height',
  'width',
  'quantity',
  'milling_type_id',
  'hdf_parameter_override_mm',
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

export function findOrderDetailInlineEditor(
  row: ParentNode | null,
  field: string,
): HTMLElement | null {
  const editingCell = row?.querySelector<HTMLElement>(
    `[data-order-detail-column-key="${field}"]`,
  );
  return editingCell?.querySelector<HTMLElement>(
    'input, textarea, [role="combobox"]',
  ) ?? null;
}

export function focusOrderDetailInlineEditorAtEnd(editor: HTMLElement | null): void {
  if (!editor) return;
  editor.focus({ preventScroll: true });
  const input = editor as HTMLElement & {
    value?: string;
    setSelectionRange?: (selectionStart: number, selectionEnd: number) => void;
  };
  if (typeof input.value !== 'string' || typeof input.setSelectionRange !== 'function') return;
  const end = input.value.length;
  input.setSelectionRange(end, end);
}

interface FinishOrderDetailInlineTabOptions {
  saveCurrentRow: () => Promise<boolean>;
  isLastRow: boolean;
  onQuickAdd?: () => boolean | Promise<boolean>;
}

export async function finishOrderDetailInlineTab({
  saveCurrentRow,
  isLastRow,
  onQuickAdd,
}: FinishOrderDetailInlineTabOptions): Promise<boolean> {
  const saved = await saveCurrentRow();
  if (saved && isLastRow) {
    return (await onQuickAdd?.()) !== false;
  }
  return saved;
}

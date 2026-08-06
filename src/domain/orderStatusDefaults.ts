export const DEFAULT_NEW_ORDER_STATUS_NAME = 'Предварительный';

interface OrderStatusDefaultOption {
  readonly label?: unknown;
  readonly value?: unknown;
}

const normalizedDefaultStatusName = normalizeStatusName(DEFAULT_NEW_ORDER_STATUS_NAME);

/**
 * New-order forms prefer the business default by name. `sort_order` remains a
 * presentation concern; the first valid option is only a compatibility fallback.
 */
export function resolveDefaultNewOrderStatusId(
  options: readonly OrderStatusDefaultOption[] | undefined,
): number | undefined {
  const preferred = options?.find(
    (option) => isValidStatusId(option.value)
      && typeof option.label === 'string'
      && normalizeStatusName(option.label) === normalizedDefaultStatusName,
  );
  if (preferred && isValidStatusId(preferred.value)) {
    return preferred.value;
  }

  const fallback = options?.find((option) => isValidStatusId(option.value));
  return fallback && isValidStatusId(fallback.value) ? fallback.value : undefined;
}

function normalizeStatusName(value: string): string {
  return value.trim().toLowerCase();
}

function isValidStatusId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

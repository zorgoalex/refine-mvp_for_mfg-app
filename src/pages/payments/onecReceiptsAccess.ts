import { featureFlags } from '../../config/featureFlags';
import { can } from '../../utils/permissions';

/**
 * Поступления 1С видны при включённой интеграции 1С и всех трёх правах; backend проверяет те же права. Один gate для
 * вкладки «Платежи → Поступления 1С» и для платежей 1С во вкладке «Финансы» заказа.
 */
export function canSeeOnecReceiptsTab(): boolean {
  return featureFlags.useBackendOnec && can('payments.onec.view') && can('payments.view') && can('orders.view_financials');
}

/** Ссылка на карточку строки 1С во вкладке «Платежи → Поступления 1С». */
export function onecReceiptCardPath(lineId: number): string {
  return `/payments?tab=onec&onecLine=${lineId}`;
}

/** `onecLine` из адреса экрана «Платежи»: только положительное целое. */
export function readOnecLineParam(search: string): number | null {
  const raw = new URLSearchParams(search).get('onecLine');
  if (raw === null || !/^[1-9]\d{0,15}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

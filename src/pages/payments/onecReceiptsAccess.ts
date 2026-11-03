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

/** Адрес без одноразовых параметров ссылки на карточку 1С (`tab`, `onecLine`); остальные параметры (фильтры списка) — как были. */
export function withoutOnecLinkParams(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('tab');
  params.delete('onecLine');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/** Запрос «открыть карточку строки 1С», пришедший ссылкой. `seq` растёт с каждой ссылкой (та же строка — снова). */
export interface OnecCardRequestState {
  pending: { lineId: number; seq: number } | null;
  /** Счётчик ссылок; не сбрасывается вместе с выполненным запросом. */
  seq: number;
}
export type OnecCardRequestAction = { type: 'link'; lineId: number } | { type: 'consumed'; seq: number };

/**
 * Ссылка ставит запрос; вкладка «Поступления 1С», открыв карточку, подтверждает его (`consumed`) — запрос снимается,
 * и повторный показ вкладки (переключение, пересоздание панели) карточку больше не открывает.
 */
export function onecCardRequestReducer(state: OnecCardRequestState, action: OnecCardRequestAction): OnecCardRequestState {
  if (action.type === 'link') {
    const seq = state.seq + 1;
    return { pending: { lineId: action.lineId, seq }, seq };
  }
  // Подтверждение устаревшего запроса (пришла новая ссылка) не снимает новый.
  return state.pending && state.pending.seq === action.seq ? { ...state, pending: null } : state;
}

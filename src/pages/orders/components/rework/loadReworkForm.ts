import type { OrderReworkAvailability, OrderReworkReason, OrderReworkState } from '../../../../api/orderReworkApi';
import type { OrderDto } from '../../../../api/types/orderApi.types';
import { reworkFormVersion, type ReworkDetailRow } from './orderReworkModel';

export const REWORK_UNAVAILABLE_TEXT: Record<Exclude<OrderReworkAvailability, 'available'>, string> = {
  disabled_flag: 'Переделка заказов выключена',
  mdf_engine_unsupported: 'Переделка станет доступна после поддержки кругов в МДФ-движке',
  mdf_cutover_in_progress: 'Идёт переключение производственного учёта, повторите позже',
};

export interface ReworkFormData {
  state: OrderReworkState;
  reasons: OrderReworkReason[];
  details: ReworkDetailRow[];
}

export type ReworkFormLoad =
  | { kind: 'open'; data: ReworkFormData }
  | { kind: 'message'; level: 'info' | 'warning'; text: string }
  /** A newer request (or a close) superseded this one: show nothing. */
  | { kind: 'stale' };

export interface ReworkFormLoadDependencies {
  availability: () => Promise<{ availability: OrderReworkAvailability }>;
  reasons: () => Promise<{ data: OrderReworkReason[] }>;
  rounds: (orderId: number) => Promise<OrderReworkState>;
  getOrder: (orderId: number) => Promise<OrderDto>;
  /** false once a newer request or a close superseded this load. */
  isCurrent: () => boolean;
  attempts?: number;
}

/**
 * The data of the rework form opened from a status picker. The rounds and the details must be one state of the order —
 * the form sends the rounds' version (If-Match) for the details it shows — so both are read until their versions agree
 * (an order changing meanwhile is re-read); a superseded load answers `stale`.
 */
export async function loadReworkForm(orderId: number, deps: ReworkFormLoadDependencies): Promise<ReworkFormLoad> {
  const [availability, reasons] = await Promise.all([deps.availability(), deps.reasons()]);
  if (!deps.isCurrent()) return { kind: 'stale' };
  if (availability.availability !== 'available') {
    return { kind: 'message', level: 'warning', text: REWORK_UNAVAILABLE_TEXT[availability.availability] };
  }
  for (let attempt = 0; attempt < (deps.attempts ?? 3); attempt += 1) {
    const [state, order] = await Promise.all([deps.rounds(orderId), deps.getOrder(orderId)]);
    if (!deps.isCurrent()) return { kind: 'stale' };
    if (!state.order.canRework) return { kind: 'message', level: 'warning', text: 'Нет права изменять этот заказ' };
    if (state.order.action === null) {
      return { kind: 'message', level: 'info', text: 'Для заказа в этом статусе переделка недоступна' };
    }
    if (reworkFormVersion(state.order.version, Number(order.header.version ?? Number.NaN)) === null) continue;
    return {
      kind: 'open',
      data: {
        state,
        reasons: reasons.data,
        details: order.details.map((detail) => ({
          id: Number(detail.id),
          detailNumber: detail.detailNumber == null ? null : Number(detail.detailNumber),
          name: String(detail.detailName ?? ''),
          productionStatusId: detail.productionStatusId == null ? null : Number(detail.productionStatusId),
          productionRound: Number(detail.productionRound ?? 1),
        })),
      },
    };
  }
  return { kind: 'message', level: 'warning', text: 'Заказ сейчас меняется — повторите через минуту' };
}

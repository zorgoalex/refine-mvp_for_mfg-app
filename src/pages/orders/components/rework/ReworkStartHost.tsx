import React, { useCallback, useEffect, useState } from 'react';
import { message } from 'antd';
import { useList } from '@refinedev/core';
import { orderReworkApi, type OrderReworkReason, type OrderReworkState } from '../../../../api/orderReworkApi';
import { ordersApi } from '../../../../api/ordersApi';
import { can } from '../../../../utils/permissions';
import type { ReworkDetailRow, ReworkStageOption } from './orderReworkModel';
import { ReworkStartModal } from './ReworkStartModal';
import { subscribeReworkStart, type ReworkStartRequest } from './reworkStartRequests';

const UNAVAILABLE_TEXT = {
  disabled_flag: 'Переделка заказов выключена',
  mdf_engine_unsupported: 'Переделка станет доступна после поддержки кругов в МДФ-движке',
  mdf_cutover_in_progress: 'Идёт переключение производственного учёта, повторите позже',
} as const;

interface LoadedRework {
  request: ReworkStartRequest;
  state: OrderReworkState;
  reasons: OrderReworkReason[];
  details: ReworkDetailRow[];
}

const errorText = (error: unknown) =>
  (error as { message?: string } | null)?.message ?? 'Не удалось выполнить действие';

/**
 * App-level host of the rework form for status pickers outside the order card (order header menu, order form, calendar,
 * status board): loads the order's rounds, details, reasons and stages and opens the same form as the card's «⋯» menu.
 */
export const ReworkStartHost: React.FC = () => {
  const [loaded, setLoaded] = useState<LoadedRework | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: stagesData } = useList({
    resource: 'production_statuses',
    pagination: { pageSize: 100 },
    filters: [{ field: 'is_active', operator: 'in', value: [true, false] }],
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'production_status_id', order: 'asc' }],
    queryOptions: { enabled: Boolean(loaded) },
  });
  const stages: ReworkStageOption[] = (stagesData?.data ?? []).map((status: Record<string, unknown>) => ({
    id: Number(status.production_status_id),
    name: String(status.production_status_name ?? ''),
    sortOrder: Number(status.sort_order ?? 0),
    code: status.production_status_code == null ? null : String(status.production_status_code),
    isActive: status.is_active !== false,
  }));

  const open = useCallback(async (request: ReworkStartRequest) => {
    if (!can('orders.rework')) {
      message.warning('Статус «Переделка» ставится командой переделки — нужно право «Переделка»');
      return;
    }
    try {
      const [state, availability, reasons, order] = await Promise.all([
        orderReworkApi.rounds(request.orderId),
        orderReworkApi.availability(),
        orderReworkApi.reasons(),
        ordersApi.getById(request.orderId),
      ]);
      if (availability.availability !== 'available') {
        message.warning(UNAVAILABLE_TEXT[availability.availability]);
        return;
      }
      if (!state.order.canRework) {
        message.warning('Нет права изменять этот заказ');
        return;
      }
      if (state.order.action === null) {
        message.info('Для заказа в этом статусе переделка недоступна');
        return;
      }
      setLoaded({
        request,
        state,
        reasons: reasons.data,
        details: order.details.map((detail) => ({
          id: Number(detail.id),
          detailNumber: detail.detailNumber == null ? null : Number(detail.detailNumber),
          name: String(detail.detailName ?? ''),
          productionStatusId: detail.productionStatusId == null ? null : Number(detail.productionStatusId),
          productionRound: Number(detail.productionRound ?? 1),
        })),
      });
    } catch (error) {
      message.error(errorText(error));
    }
  }, []);

  useEffect(() => subscribeReworkStart((request) => { void open(request); }), [open]);

  if (!loaded || stages.length === 0) return null;
  const { order } = loaded.state;
  const close = () => setLoaded(null);
  return (
    <ReworkStartModal
      orderId={loaded.request.orderId}
      version={order.version}
      action={order.action!}
      openRoundNo={order.openRoundNo}
      roundNo={order.openRoundNo ?? order.lastRoundNo + 1}
      details={loaded.details}
      stages={stages}
      reasons={loaded.reasons}
      busy={busy}
      setBusy={setBusy}
      onCancel={close}
      onDone={async (text) => {
        message.success(text);
        const done = loaded.request.onDone;
        close();
        done?.();
      }}
      onFailed={async (error) => {
        message.error(errorText(error));
        // 409 (the order changed meanwhile): the form was opened on stale data — close it; picking again re-reads.
        if ((error as { status?: number; statusCode?: number } | null)?.status === 409
          || (error as { statusCode?: number } | null)?.statusCode === 409) close();
      }}
    />
  );
};

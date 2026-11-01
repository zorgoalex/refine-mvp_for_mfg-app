import React, { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import { useList } from '@refinedev/core';
import { orderReworkApi } from '../../../../api/orderReworkApi';
import { ordersApi } from '../../../../api/ordersApi';
import { can } from '../../../../utils/permissions';
import { createLatestGate, type ReworkStageOption } from './orderReworkModel';
import { loadReworkForm, type ReworkFormData } from './loadReworkForm';
import { ReworkStartModal } from './ReworkStartModal';
import { subscribeReworkStart, type ReworkStartRequest } from './reworkStartRequests';


interface LoadedRework extends ReworkFormData {
  /** The open request it belongs to: a newer request or a close drops a late answer, and each opening is a new form. */
  ticket: number;
  request: ReworkStartRequest;
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
  const gate = useRef(createLatestGate()).current;
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
    const ticket = gate.begin();
    setLoaded(null); // a form of another order closes; this one opens when its data agrees
    try {
      const result = await loadReworkForm(request.orderId, {
        availability: () => orderReworkApi.availability(),
        reasons: () => orderReworkApi.reasons(),
        rounds: (orderId) => orderReworkApi.rounds(orderId),
        getOrder: (orderId) => ordersApi.getById(orderId),
        isCurrent: () => gate.isLatest(ticket),
      });
      if (result.kind === 'message') message[result.level](result.text);
      if (result.kind === 'open') setLoaded({ ticket, request, ...result.data });
    } catch (error) {
      if (gate.isLatest(ticket)) message.error(errorText(error));
    }
  }, [gate]);

  useEffect(() => subscribeReworkStart((request) => { void open(request); }), [open]);

  if (!loaded || stages.length === 0) return null;
  const { order } = loaded.state;
  const close = () => { gate.begin(); setLoaded(null); };
  return (
    <ReworkStartModal
      key={loaded.ticket}
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

import { useEffect, useMemo, useState } from 'react';

import { isApiError } from '../../../../api/apiError';
import { useKeepAlive } from '../../../../components/workspace/KeepAliveContext';
import { paymentsOnecApi } from '../../../../api/paymentsOnecApi';
import type { OnecReceiptListItemDto } from '../../../../api/types/paymentsOnecApi.types';
import { canSeeOnecReceiptsTab } from '../../../payments/onecReceiptsAccess';
import { splitOrderOnecReceipts, type OrderOnecReceiptsSplit } from './orderOnecReceipts';

const PAGE_SIZE = 100;
/** Предел страниц на заказ: у одного заказа столько строк 1С не бывает; больше — показываем первые и пишем об этом. */
const MAX_PAGES = 10;

export type OrderOnecReceiptsState =
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; split: OrderOnecReceiptsSplit; total: number; truncated: boolean };

const OFF: OrderOnecReceiptsState = { status: 'off' };

/**
 * Платежи 1С заказа для вкладки «Финансы» (только чтение): `GET /payments/onec-receipts?orderId=`. Тот же gate, что у
 * вкладки «Поступления 1С»; выключенная сверка или нет прав — блок не показывается вовсе (`off`).
 *
 * Перечитывается при каждой активации вкладки workspace (`activationRevision`: сверку меняют на экране «Платежи», а
 * вкладка заказа остаётся смонтированной) и при смене `refreshKey` (сохранённые платежи заказа изменились).
 */
export function useOrderOnecReceipts(orderId: number | null | undefined, refreshKey = ''): OrderOnecReceiptsState {
  const { activationRevision } = useKeepAlive();
  const enabled = typeof orderId === 'number' && Number.isSafeInteger(orderId) && orderId > 0 && canSeeOnecReceiptsTab();
  const [state, setState] = useState<OrderOnecReceiptsState>(enabled ? { status: 'loading' } : OFF);

  useEffect(() => {
    if (!enabled) {
      setState(OFF);
      return undefined;
    }
    let active = true;
    // Перечитывание не мигает: прежние данные видны до ответа.
    setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }));
    (async () => {
      const rows: OnecReceiptListItemDto[] = [];
      let total = 0;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const response = await paymentsOnecApi.listReceipts({ page, pageSize: PAGE_SIZE, orderId: orderId as number });
        rows.push(...response.data);
        total = response.pagination.total;
        if (rows.length >= total || response.data.length === 0) break;
      }
      return { rows, total };
    })()
      .then(({ rows, total }) => {
        if (active) setState({ status: 'ready', split: splitOrderOnecReceipts(rows, orderId as number), total, truncated: rows.length < total });
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (isApiError(error, 'ONEC_PAYMENT_MATCHING_DISABLED') || isApiError(error, 'PERMISSION_DENIED')) setState(OFF);
        else setState({ status: 'error', message: 'Не удалось загрузить платежи 1С по заказу.' });
      });
    return () => {
      active = false;
    };
  }, [enabled, orderId, activationRevision, refreshKey]);

  return useMemo(() => (enabled ? state : OFF), [enabled, state]);
}

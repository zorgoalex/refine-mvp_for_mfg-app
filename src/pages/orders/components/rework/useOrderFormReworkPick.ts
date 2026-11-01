import { useCallback } from 'react';
import { message } from 'antd';
import { loadOrderViaBackend } from '../../../../hooks/useOrderBackendRead';
import { useOrderDraftStoreApi } from '../../../../stores/orderFormStore';
import { requestReworkStart } from './reworkStartRequests';

/**
 * Picking the status «Переделка» in the order form: the status is set by the rework command, which also moves the
 * details' stages and the order version — so the form must hold no unsaved edits (a later save would conflict with the
 * round or overwrite it), and is re-read from the backend after the command.
 */
export function useOrderFormReworkPick(): (orderId: number | null | undefined) => void {
  const storeApi = useOrderDraftStoreApi();
  return useCallback((orderId) => {
    if (!orderId) {
      message.warning('Сначала сохраните заказ');
      return;
    }
    if (storeApi.getState().isDirty) {
      message.warning('Сначала сохраните изменения заказа, затем выберите «Переделка»');
      return;
    }
    const opened = requestReworkStart({
      orderId,
      onDone: () => {
        void loadOrderViaBackend(orderId, {
          getOrderStore: () => storeApi.getState(),
          // An edit made while the command ran wins; the user re-opens the order to see the round.
          canPublish: () => !storeApi.getState().isDirty,
        }).then((loaded) => {
          if (!loaded) message.info('Обновите заказ, чтобы увидеть переделку');
        }).catch(() => message.info('Обновите заказ, чтобы увидеть переделку'));
      },
    });
    if (!opened) message.warning('Статус «Переделка» ставится командой переделки в карточке заказа (меню «⋯»)');
  }, [storeApi]);
}

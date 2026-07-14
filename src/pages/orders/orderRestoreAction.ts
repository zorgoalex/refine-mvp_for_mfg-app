import { isApiError } from '../../api/apiError';
import { createOrderRestoreIdempotencyKey } from '../../api/ordersApi';

export interface RestoreDeps {
  restoreFn: (req: {
    version: number;
    orderName?: string;
    idempotencyKey: string;
  }) => Promise<unknown>;
  confirmFn: (message: string) => Promise<boolean>;
  notify: {
    success: (message: string) => void;
    warning: (message: string) => void;
    error: (message: string) => void;
  };
  onRestored: () => void;
  onStale: () => void;
}

export function makeRestoreHandler(deps: RestoreDeps): (version: number) => Promise<void> {
  return async (version: number) => {
    try {
      await deps.restoreFn({ version, idempotencyKey: createOrderRestoreIdempotencyKey() });
      deps.notify.success('Заказ восстановлен');
      deps.onRestored();
    } catch (err) {
      if (isApiError(err, 'ORDER_NAME_DUPLICATE')) {
        const details = (err as {
          details?: { existingOrderId?: number; suggestedOrderName?: string | null };
        }).details;
        const suggested = details?.suggestedOrderName ?? null;
        if (!suggested) {
          deps.notify.warning(
            `Номер занят заказом #${details?.existingOrderId ?? '—'}, свободный номер недоступен`,
          );
          return;
        }
        const ok = await deps.confirmFn(
          `Номер занят заказом #${details?.existingOrderId ?? '—'}. Восстановить как ${suggested}?`,
        );
        if (!ok) return;
        try {
          await deps.restoreFn({
            version,
            orderName: suggested,
            idempotencyKey: createOrderRestoreIdempotencyKey(),
          });
          deps.notify.success(`Заказ восстановлен как ${suggested}`);
          deps.onRestored();
        } catch (retryErr) {
          deps.notify.error(
            retryErr instanceof Error ? retryErr.message : 'Не удалось восстановить заказ',
          );
        }
        return;
      }
      if (isApiError(err, 'ORDER_NOT_DELETED')) {
        deps.onStale();
        return;
      }
      if (isApiError(err, 'ORDER_VERSION_CONFLICT')) {
        deps.notify.error('Данные устарели, обновите список');
        deps.onStale();
        return;
      }
      if (isApiError(err, 'ORDER_RESTORE_CONFLICT')) {
        deps.notify.error('Конкурентное изменение, повторите попытку');
        deps.onStale();
        return;
      }
      deps.notify.error(err instanceof Error ? err.message : 'Не удалось восстановить заказ');
    }
  };
}

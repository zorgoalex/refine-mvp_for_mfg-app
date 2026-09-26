import { isApiError } from '../../api/apiError';
import { isMdfOrderConflictError } from '../../utils/mdfOrderConflict';

export function makeOrderDeleteHandler(deps: {
  capturePublicationGuard: () => (() => boolean) | null;
  deleteFn: () => Promise<unknown>;
  onSuccess: () => void;
  onVersionConflict: () => void;
  onError: (message: string) => void;
  onMdfConflict?: (error: unknown) => void;
}): () => Promise<void> {
  return async () => {
    const canPublish = deps.capturePublicationGuard();
    if (!canPublish) return;
    try {
      await deps.deleteFn();
      if (!canPublish()) return;
      deps.onSuccess();
    } catch (err) {
      if (!canPublish()) return;
      if (isApiError(err, 'ORDER_VERSION_CONFLICT')) {
        deps.onVersionConflict();
        return;
      }

      if (deps.onMdfConflict && isMdfOrderConflictError(err)) {
        deps.onMdfConflict(err);
        return;
      }

      deps.onError(err instanceof Error ? err.message : 'Не удалось удалить заказ');
    }
  };
}

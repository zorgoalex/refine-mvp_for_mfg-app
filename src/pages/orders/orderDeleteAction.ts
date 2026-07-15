import { isApiError } from '../../api/apiError';

export function makeOrderDeleteHandler(deps: {
  deleteFn: () => Promise<unknown>;
  onSuccess: () => void;
  onVersionConflict: () => void;
  onError: (message: string) => void;
}): () => Promise<void> {
  return async () => {
    try {
      await deps.deleteFn();
      deps.onSuccess();
    } catch (err) {
      if (isApiError(err, 'ORDER_VERSION_CONFLICT')) {
        deps.onVersionConflict();
        return;
      }

      deps.onError(err instanceof Error ? err.message : 'Не удалось удалить заказ');
    }
  };
}

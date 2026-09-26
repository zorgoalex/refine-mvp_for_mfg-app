import { isApiError } from '../../api/apiError';
import { isMdfOrderConflictError } from '../../utils/mdfOrderConflict';

export function makeOrderDeleteHandler(deps: {
  capturePublicationGuard: () => (() => boolean) | null;
  // confirmationDigest is set only on the resend after the user confirmed an
  // MDF board conflict (see onMdfConflict below); the caller must resend the
  // identical delete request (same version/Idempotency-Key) with it attached.
  deleteFn: (confirmationDigest?: string) => Promise<unknown>;
  onSuccess: () => void;
  onVersionConflict: () => void;
  onError: (message: string) => void;
  // `confirm` resends deleteFn with the given digest and replays this same
  // handling (success / version conflict / another MDF conflict, e.g. STALE
  // with a fresh digest) — call it from the confirmation modal's onConfirm.
  onMdfConflict?: (error: unknown, confirm: (digest: string) => Promise<void>) => void;
}): () => Promise<void> {
  return async () => {
    const canPublish = deps.capturePublicationGuard();
    if (!canPublish) return;

    const attempt = async (confirmationDigest?: string): Promise<void> => {
      try {
        await deps.deleteFn(confirmationDigest);
        if (!canPublish()) return;
        deps.onSuccess();
      } catch (err) {
        if (!canPublish()) return;
        if (isApiError(err, 'ORDER_VERSION_CONFLICT')) {
          deps.onVersionConflict();
          return;
        }

        if (deps.onMdfConflict && isMdfOrderConflictError(err)) {
          deps.onMdfConflict(err, (digest) => attempt(digest));
          return;
        }

        deps.onError(err instanceof Error ? err.message : 'Не удалось удалить заказ');
      }
    };

    await attempt();
  };
}

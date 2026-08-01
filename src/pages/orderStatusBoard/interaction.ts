import { isApiError } from '../../api/apiError';
import {
  isProductionActionPermissionDenied,
  isProductionActionVersionConflict,
} from '../../api/productionActionsApi';
import type {
  OrderStatusBoardCard,
  OrderStatusBoardType,
} from '../../api/types/orderStatusBoardApi.types';

export interface ExecuteBoardMoveInput {
  board: OrderStatusBoardType;
  card: OrderStatusBoardCard;
  targetStatusId: number;
  targetName: string;
  idempotencyKey: string;
}

export interface ExecuteBoardMoveDependencies {
  confirmManualProductionMove: (
    card: OrderStatusBoardCard,
    targetName: string,
  ) => Promise<boolean>;
  changeOrderStatus: (
    orderId: number,
    request: { orderStatusId: number; version: number; idempotencyKey: string },
  ) => Promise<unknown>;
  changeProductionStatus: (
    orderId: number,
    request: { productionStatusId: number; version: number; idempotencyKey: string },
  ) => Promise<unknown>;
  afterCommand: () => void;
  refetch: () => Promise<boolean>;
}

export type ExecuteBoardMoveResult =
  | { kind: 'cancelled' }
  | { kind: 'refreshed' }
  | { kind: 'stale' };

export async function executeOrderStatusBoardMove(
  input: ExecuteBoardMoveInput,
  dependencies: ExecuteBoardMoveDependencies,
): Promise<ExecuteBoardMoveResult> {
  if (
    input.board === 'production' &&
    input.card.productionStatusFromDetailsEnabled
  ) {
    const confirmed = await dependencies.confirmManualProductionMove(
      input.card,
      input.targetName,
    );
    if (!confirmed) return { kind: 'cancelled' };
  }

  if (input.board === 'order') {
    await dependencies.changeOrderStatus(input.card.orderId, {
      orderStatusId: input.targetStatusId,
      version: input.card.version,
      idempotencyKey: input.idempotencyKey,
    });
  } else {
    await dependencies.changeProductionStatus(input.card.orderId, {
      productionStatusId: input.targetStatusId,
      version: input.card.version,
      idempotencyKey: input.idempotencyKey,
    });
  }

  dependencies.afterCommand();
  return (await dependencies.refetch())
    ? { kind: 'refreshed' }
    : { kind: 'stale' };
}

export function reserveOrderStatusBoardMutation(
  pending: ReadonlySet<number>,
  orderId: number,
): Set<number> | null {
  if (pending.size > 0) return null;
  return new Set(pending).add(orderId);
}

export type OrderStatusBoardMoveFailure =
  | 'version-conflict'
  | 'permission-denied'
  | 'status-unavailable'
  | 'ambiguous';

export function classifyOrderStatusBoardMoveFailure(
  error: unknown,
): OrderStatusBoardMoveFailure {
  if (isProductionActionVersionConflict(error)) return 'version-conflict';
  if (isProductionActionPermissionDenied(error)) return 'permission-denied';
  if (
    isApiError(error) &&
    (error.status === 422 || error.code === 'STATUS_NOT_FOUND')
  ) {
    return 'status-unavailable';
  }
  return 'ambiguous';
}

export interface BoardFocusTarget {
  isConnected?: boolean;
  focus: () => void;
}

export function restoreOrderStatusBoardFocus(
  orderId: number,
  trigger: BoardFocusTarget | null,
  findCard: (orderId: number) => BoardFocusTarget | null,
  findTitle: () => BoardFocusTarget | null,
): 'card' | 'trigger' | 'title' | 'none' {
  const card = findCard(orderId);
  if (card) {
    card.focus();
    return 'card';
  }
  if (trigger && trigger.isConnected !== false) {
    trigger.focus();
    return 'trigger';
  }
  const title = findTitle();
  if (title) {
    title.focus();
    return 'title';
  }
  return 'none';
}

export function syncCncBathSelectedDetail(
  root: HTMLElement | null,
  selectedDetailId: number | null,
): void {
  if (!root) return;
  for (const piece of root.querySelectorAll<SVGElement>('[data-detail-id]')) {
    const selected = Number(piece.getAttribute('data-detail-id')) === selectedDetailId;
    if (selected) {
      piece.setAttribute('data-cnc-selected-detail', 'true');
    } else {
      piece.removeAttribute('data-cnc-selected-detail');
    }
  }
}

export function releaseCncPreviewLoadKey(
  currentKey: string | null,
  requestKey: string,
  loaded: boolean,
): string | null {
  return !loaded && currentKey === requestKey ? null : currentKey;
}

export function isCncPreviewRequestCurrent(
  cancelled: boolean,
  currentRequestSeq: number,
  requestSeq: number,
): boolean {
  return !cancelled && currentRequestSeq === requestSeq;
}

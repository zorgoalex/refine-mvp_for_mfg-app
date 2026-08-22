export interface OrderDraftAuthorityState {
  isDirty: boolean;
  header: { order_id?: unknown };
}

export function isAuthoritativeDirtyOrderDraft(
  draft: OrderDraftAuthorityState,
  orderId: number,
): boolean {
  const draftOrderId = Number(draft.header.order_id);
  return draft.isDirty
    && Number.isSafeInteger(draftOrderId)
    && draftOrderId > 0
    && draftOrderId === orderId;
}

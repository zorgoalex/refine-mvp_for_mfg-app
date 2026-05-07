export interface OrderShowLoadingState {
  orderLoading: boolean;
  detailsLoading: boolean;
  useBackendOrdersRead: boolean;
}

export function shouldShowOrderLoading({
  orderLoading,
  detailsLoading,
  useBackendOrdersRead,
}: OrderShowLoadingState): boolean {
  return orderLoading || (!useBackendOrdersRead && detailsLoading);
}
